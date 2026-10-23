import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  controlUiE2eWaitTimeoutMs,
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

type EntrySample = { id: number; kind: string; y: number; height: number };
type TimedEntrySample = EntrySample & { time: number };
type EntryFrame = { time: number; samples: EntrySample[] };
type EntryRecorder = { enabled: boolean; done: boolean; frames: EntryFrame[] };
const homeKey = "agent:main:main";
const entryKey = "agent:main:entry-proof";
const chooseSession = "Choose the session in the sidebar.";
const text = (value: string) => ({ type: "text", text: value });

declare global {
  interface Window {
    sessionEntryRecorder: EntryRecorder;
  }
}

const suite = createControlUiE2eSuite({
  name: "chat session entry",
  browserLaunchOptions: {
    channel: "chromium",
    args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
  },
});
const scenarios = (["boot", "direct", "sidebar"] as const).flatMap((entry) =>
  [4, 160].flatMap((count) =>
    [1440, 390].flatMap((width) =>
      (["no-preference", "reduce"] as const).flatMap((reducedMotion) =>
        (["light", "dark"] as const).map(
          (colorScheme) => [entry, count, width, reducedMotion, colorScheme] as const,
        ),
      ),
    ),
  ),
);

type RecorderOptions = { target: string; enabled: boolean; lastEntryId: string };
function recordEntryFrames({ target, enabled, lastEntryId }: RecorderOptions) {
  const recorder: EntryRecorder = { enabled, done: false, frames: [] };
  window.sessionEntryRecorder = recorder;
  const ids = new WeakMap<Element, number>();
  let nextId = 0;
  let lastEntryPaintedAt: number | undefined;
  let lastEntryPaintedFrames = 0;
  const visibility = {
    contentVisibilityAuto: true,
    opacityProperty: true,
    visibilityProperty: true,
  };
  const tick = (time: number) => {
    if (recorder.done) {
      return;
    }
    requestAnimationFrame(tick);
    if (!recorder.enabled) {
      return;
    }
    const panes = document.querySelectorAll<HTMLElement & { sessionKey: string }>(
      "openclaw-chat-pane",
    );
    const pane = Array.from(panes).find(
      (el) => el.sessionKey === target && el.getBoundingClientRect().height > 0,
    );
    const thread = pane?.querySelector<HTMLElement>(".chat-thread");
    const viewport = thread?.getBoundingClientRect();
    const elements = [
      document.querySelector(".shell"),
      ...(pane?.querySelectorAll(
        ".chat-pane__header, .agent-chat__header--mobile, .chat, .chat-bubble[data-entry-id]",
      ) ?? []),
    ];
    const samples: EntrySample[] = [];
    for (const element of elements) {
      // Layout boxes alone do not prove that pixels were painted.
      if (!element?.checkVisibility(visibility)) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const entryId = element.getAttribute("data-entry-id");
      if (
        !rect.height ||
        (entryId && (!viewport || rect.bottom <= viewport.top || rect.top >= viewport.bottom))
      ) {
        continue;
      }
      let id = ids.get(element);
      if (id === undefined) {
        id = ++nextId;
        ids.set(element, id);
      }
      const kind =
        entryId ??
        (element.matches(".chat-pane__header, .agent-chat__header--mobile")
          ? "session-header"
          : element.className);
      samples.push({ id, kind, y: rect.y, height: rect.height });
      if (entryId === lastEntryId) {
        lastEntryPaintedAt ??= time;
        lastEntryPaintedFrames += 1;
      }
    }
    if (samples.length) {
      recorder.frames.push({ time, samples });
    }
    // Include the first paint and outlast the 300 ms entry animation.
    if (
      lastEntryPaintedAt !== undefined &&
      time - lastEntryPaintedAt >= 750 &&
      lastEntryPaintedFrames >= 10
    ) {
      recorder.done = true;
    }
  };
  requestAnimationFrame(tick);
}

function assertEntryFrames(frames: EntryFrame[], lastEntryId: string) {
  expect(frames.length).toBeGreaterThanOrEqual(10);
  const samplesById = new Map<number, [TimedEntrySample, ...TimedEntrySample[]]>();
  for (const { time, samples } of frames) {
    for (const sample of samples) {
      const timed = { ...sample, time };
      const trace = samplesById.get(sample.id);
      if (trace) {
        trace.push(timed);
      } else {
        samplesById.set(sample.id, [timed]);
      }
    }
  }
  const observed = Array.from(samplesById.values());
  for (const kind of ["session-header", "chat", "shell", lastEntryId]) {
    const samples = observed.find((rows) => rows[0].kind.split(" ").includes(kind));
    expect(samples?.length, `${kind} painted frame coverage`).toBeGreaterThanOrEqual(10);
    const duration = samples!.at(-1)!.time - samples![0].time;
    expect(duration, `${kind} observation duration`).toBeGreaterThanOrEqual(700);
  }
  expect(
    observed.filter((rows) => rows[0].kind.startsWith("entry-")).length,
  ).toBeGreaterThanOrEqual(2);
  // Transcript scrolling is independent of inherited shell/header/chat entry motion.
  for (const samples of observed.filter((rows) => !rows[0].kind.startsWith("entry-"))) {
    const positions = samples.map((sample) => sample.y);
    // Allow only floating-point layout noise, below one device pixel.
    expect(
      Math.max(...positions) - Math.min(...positions),
      `${samples[0].kind} vertical displacement`,
    ).toBeLessThanOrEqual(0.1);
  }
}

suite.define(() => {
  for (const [entry, count, width, reducedMotion, colorScheme] of scenarios) {
    it(`opens the session frame at its final position: ${entry}, ${count} messages, ${width} px, ${reducedMotion}, ${colorScheme}`, async () => {
      await suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          viewport: { width, height: 900 },
          deviceScaleFactor: 2,
          reducedMotion,
          colorScheme,
        },
        async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const target = entry === "boot" ? homeKey : entryKey;
          const messages = Array.from({ length: count }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: [
              text(
                `Entry checkpoint ${index + 1}. ${index % 2 ? "The transcript should appear in its final position." : "Review this session and preserve the reading position."}`,
              ),
            ],
            timestamp: Date.UTC(2026, 8, 10, 12, index),
            __openclaw: { id: `entry-${index}`, seq: index + 1 },
          }));
          const gateway = await installMockGateway(page, {
            sessionKey: target,
            sessionTranscripts:
              entry === "sidebar"
                ? {
                    [homeKey]: {
                      messages: [{ role: "assistant", content: [text(chooseSession)] }],
                    },
                    [target]: { messages },
                  }
                : { [target]: { messages } },
            sessions: [
              { key: homeKey, label: "Home", kind: "direct", updatedAt: 1000 },
              { key: entryKey, label: "Entry proof", kind: "direct", updatedAt: 2000 },
            ],
            models: [{ id: "mock-model", name: "Mock model", provider: "mock" }],
            agentModel: "mock/mock-model",
          });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.addInitScript(
            ({ key, ...settings }) => localStorage.setItem(key, JSON.stringify(settings)),
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
              theme: "claw",
              themeMode: colorScheme,
            },
          );
          await page.addInitScript(recordEntryFrames, {
            target,
            enabled: entry !== "sidebar",
            lastEntryId: `entry-${count - 1}`,
          });
          const url = controlUiSessionUrl(
            suite.server.baseUrl,
            entry === "sidebar" ? homeKey : target,
          );
          await page.goto(entry === "boot" ? `${suite.server.baseUrl}chat` : url);
          if (entry === "sidebar") {
            await page.getByText(chooseSession).waitFor();
            if (width === 390) {
              await navigationDrawerToggle(page).click();
            }
            const link = page.locator(
              `[data-session-key="${target}"] a.sidebar-recent-session__link`,
            );
            await link.waitFor();
            await page.evaluate(() => {
              window.sessionEntryRecorder.enabled = true;
            });
            await link.click();
          }
          await page.waitForFunction(() => window.sessionEntryRecorder.done, undefined, {
            timeout: controlUiE2eWaitTimeoutMs,
          });
          expect(pageErrors).toEqual([]);
          const frames = await page.evaluate(() => window.sessionEntryRecorder.frames);
          await writeFile(
            path.join(suite.artifactDir, "entry-frames.json"),
            JSON.stringify(frames, null, 2),
          );
          expect(
            await page.evaluate(() => ({
              width: innerWidth,
              theme: document.documentElement.dataset.themeMode,
              reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
              colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
            })),
          ).toEqual({
            width,
            theme: colorScheme,
            reducedMotion: reducedMotion === "reduce",
            colorScheme,
          });
          expect((await gateway.getRequests("chat.startup")).length).toBeGreaterThan(0);
          assertEntryFrames(frames, `entry-${count - 1}`);
        },
      );
    });
  }
});
