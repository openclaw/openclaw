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
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

type EntrySample = { id: number; kind: string; y: number; height: number };
type TimedEntrySample = EntrySample & { time: number };
type EntryFrame = { time: number; samples: EntrySample[]; scrollTop: number | undefined };
type EntryRecorder = { enabled: boolean; done: boolean; frames: EntryFrame[] };

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
        (["light", "dark"] as const).map((colorScheme) => ({
          entry,
          count,
          width,
          reducedMotion,
          colorScheme,
        })),
      ),
    ),
  ),
);

suite.define(() => {
  for (const { entry, count, width, reducedMotion, colorScheme } of scenarios) {
    it(`opens the session frame at its final position: ${entry}, ${count} messages, ${width} px, ${reducedMotion}, ${colorScheme}`, async (testContext) => {
      await suite.runScenario(testContext, {
        run: async () => {
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
              const target = entry === "boot" ? "agent:main:main" : "agent:main:entry-proof";
              const messages = Array.from({ length: count }, (_, index) => ({
                role: index % 2 ? "assistant" : "user",
                content: [
                  {
                    type: "text",
                    text: `Entry checkpoint ${index + 1}. ${index % 2 ? "The transcript should appear in its final position." : "Review this session and preserve the reading position."}`,
                  },
                ],
                timestamp: Date.UTC(2026, 8, 10, 12, index),
                __openclaw: { id: `entry-${index}`, seq: index + 1 },
              }));
              const gateway = await installMockGateway(page, {
                sessionKey: target,
                sessionTranscripts: {
                  [target]: { messages },
                  ...(entry === "sidebar"
                    ? {
                        "agent:main:main": {
                          messages: [
                            {
                              role: "assistant",
                              content: [
                                { type: "text", text: "Choose the session in the sidebar." },
                              ],
                            },
                          ],
                        },
                      }
                    : {}),
                },
                sessions: [
                  { key: "agent:main:main", label: "Home", kind: "direct", updatedAt: 1000 },
                  {
                    key: "agent:main:entry-proof",
                    label: "Entry proof",
                    kind: "direct",
                    updatedAt: 2000,
                  },
                ],
                models: [{ id: "mock-model", name: "Mock model", provider: "mock" }],
                agentModel: "mock/mock-model",
              });
              await page.addInitScript(createControlUiMockSameOriginGatewayScript());
              await page.addInitScript(
                ({ key, gatewayUrl, mode }) => {
                  localStorage.setItem(
                    key,
                    JSON.stringify({ gatewayUrl, theme: "claw", themeMode: mode }),
                  );
                },
                {
                  key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
                  gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
                  mode: colorScheme,
                },
              );
              await page.addInitScript(
                ({ target: sessionKey, enabled, lastEntryId }) => {
                  const recorder: EntryRecorder = { enabled, done: false, frames: [] };
                  window.sessionEntryRecorder = recorder;
                  const ids = new WeakMap<Element, number>();
                  let nextId = 0;
                  let lastEntryPaintedAt: number | undefined;
                  let lastEntryPaintedFrames = 0;
                  const tick = (time: number) => {
                    if (recorder.done) {
                      return;
                    }
                    if (recorder.enabled) {
                      const pane = Array.from(
                        document.querySelectorAll<HTMLElement & { sessionKey: string }>(
                          "openclaw-chat-pane",
                        ),
                      ).find(
                        (element) =>
                          element.sessionKey === sessionKey &&
                          element.getBoundingClientRect().height > 0,
                      );
                      const thread = pane?.querySelector<HTMLElement>(".chat-thread");
                      const viewport = thread?.getBoundingClientRect();
                      const elements = [
                        document.querySelector(".shell"),
                        ...(pane?.querySelectorAll(
                          ".chat-pane__header, .chat, .chat-bubble[data-entry-id]",
                        ) ?? []),
                      ];
                      const samples: EntrySample[] = [];
                      for (const element of elements) {
                        if (!element) {
                          continue;
                        }
                        // content-visibility and ancestor opacity can leave layout boxes
                        // measurable before any pixels are painted for this element.
                        if (
                          !element.checkVisibility({
                            contentVisibilityAuto: true,
                            opacityProperty: true,
                            visibilityProperty: true,
                          })
                        ) {
                          continue;
                        }
                        const rect = element.getBoundingClientRect();
                        if (!rect.height) {
                          continue;
                        }
                        const entryId = element.getAttribute("data-entry-id");
                        if (
                          entryId &&
                          (!viewport || rect.bottom <= viewport.top || rect.top >= viewport.bottom)
                        ) {
                          continue;
                        }
                        let id = ids.get(element);
                        if (id === undefined) {
                          id = ++nextId;
                          ids.set(element, id);
                        }
                        samples.push({
                          id,
                          kind: entryId ?? element.className,
                          y: rect.y,
                          height: rect.height,
                        });
                        if (entryId === lastEntryId) {
                          lastEntryPaintedAt ??= time;
                          lastEntryPaintedFrames += 1;
                        }
                      }
                      if (samples.length) {
                        recorder.frames.push({ time, samples, scrollTop: thread?.scrollTop });
                      }
                      // Keep all entry frames, including the first one; the window
                      // extends beyond the existing 300 ms entry effects without
                      // changing animation state or delaying the observer.
                      if (
                        lastEntryPaintedAt !== undefined &&
                        time - lastEntryPaintedAt >= 750 &&
                        lastEntryPaintedFrames >= 10
                      ) {
                        recorder.done = true;
                      }
                    }
                    requestAnimationFrame(tick);
                  };
                  requestAnimationFrame(tick);
                },
                { target, enabled: entry !== "sidebar", lastEntryId: `entry-${count - 1}` },
              );
              await page.goto(
                entry === "direct"
                  ? controlUiSessionUrl(suite.server.baseUrl, target)
                  : entry === "sidebar"
                    ? controlUiSessionUrl(suite.server.baseUrl, "agent:main:main")
                    : `${suite.server.baseUrl}chat`,
              );
              if (entry === "sidebar") {
                await page.getByText("Choose the session in the sidebar.").waitFor();
                if (width === 390) {
                  await page
                    .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
                    .first()
                    .click();
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
                  colorScheme: matchMedia("(prefers-color-scheme: dark)").matches
                    ? "dark"
                    : "light",
                })),
              ).toEqual({
                width,
                theme: colorScheme,
                reducedMotion: reducedMotion === "reduce",
                colorScheme,
              });
              expect((await gateway.getRequests("chat.startup")).length).toBeGreaterThan(0);
              expect(frames.length).toBeGreaterThanOrEqual(10);
              const samplesById = new Map<number, [TimedEntrySample, ...TimedEntrySample[]]>();
              for (const frame of frames) {
                for (const sample of frame.samples) {
                  const timedSample = { ...sample, time: frame.time };
                  const samples = samplesById.get(sample.id);
                  if (samples) {
                    samples.push(timedSample);
                  } else {
                    samplesById.set(sample.id, [timedSample]);
                  }
                }
              }
              const observed = Array.from(samplesById.values());
              for (const kind of ["chat-pane__header", "chat", "shell", `entry-${count - 1}`]) {
                const samples = observed.find((rows) => rows[0].kind.split(" ").includes(kind));
                expect(samples, `missing painted ${kind}`).toBeDefined();
                expect(samples!.length, `${kind} frame coverage`).toBeGreaterThanOrEqual(10);
                expect(
                  samples!.at(-1)!.time - samples![0].time,
                  `${kind} observation duration`,
                ).toBeGreaterThanOrEqual(700);
              }
              expect(
                observed.filter((rows) => rows[0].kind.startsWith("entry-")).length,
              ).toBeGreaterThanOrEqual(2);
              // The shell, header, and chat section carry the inherited entry motion.
              // Transcript layout inside them has its own scrolling and progress contracts.
              for (const samples of observed.filter((rows) => !rows[0].kind.startsWith("entry-"))) {
                const positions = samples.map((sample) => sample.y);
                // Allow only floating-point layout noise, below one device pixel.
                expect(
                  Math.max(...positions) - Math.min(...positions),
                  `${samples[0].kind} vertical displacement`,
                ).toBeLessThanOrEqual(0.1);
              }
            },
          );
        },
      });
    });
  }
});
