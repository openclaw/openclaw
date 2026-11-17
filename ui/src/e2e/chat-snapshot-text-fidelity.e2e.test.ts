import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import path from "node:path";
import { expect, inject, it } from "vitest";
import { installWarmReloadTranscriptProbe } from "../../../scripts/perf/warm-reload-transcript-probe.ts";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createActiveTranscriptReloadFixture } from "../test-helpers/control-ui-team-scale-history-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

function installTranscriptScrollWriteProbe() {
  const records: Array<{
    atMs: number;
    kind: string;
    before: number;
    after: number;
    failed: boolean;
    stack: string[];
  }> = [];
  let armed = false;
  let dropped = 0;
  const remember = (record: (typeof records)[number]) => {
    if (records.length === 128) {
      records.shift();
      dropped++;
    }
    records.push(record);
  };
  const selected = (element: Element) =>
    armed && element.matches(".chat-pane-cache__pane--active .chat-thread");
  const invoke = (element: Element, kind: string, call: () => unknown) => {
    if (!selected(element)) {
      return call();
    }
    const before = element.scrollTop;
    const atMs = performance.now();
    const stack = (new Error().stack ?? "")
      .split("\n")
      .flatMap((line) => {
        const frame = line.match(
          /(assets\/[A-Za-z0-9_-]+\.js|(?:ui\/)?src\/pages\/chat\/[^?:)\s]+|node_modules\/@tanstack\/virtual-core\/[^?:)\s]+|scripts\/perf\/warm-reload-transcript-probe\.ts)(?:\?[^)\s]*?)?:(\d+):(\d+)/u,
        );
        return frame ? [`${frame[1]}:${frame[2]}:${frame[3]}`] : [];
      })
      .slice(0, 6);
    let failed = false;
    try {
      return call();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      remember({ atMs, kind, before, after: element.scrollTop, failed, stack });
    }
  };
  const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (!top?.get || !top.set) {
    throw new Error("Missing native scrollTop descriptor");
  }
  const methods = (["scrollTo", "scrollBy"] as const).map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new Error(`Missing native ${name} descriptor`);
    }
    return { name, descriptor, original: descriptor.value };
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    ...top,
    set(this: Element, value: number) {
      invoke(this, "scrollTop", () => top.set?.call(this, value));
    },
  });
  for (const { name, descriptor, original } of methods) {
    Object.defineProperty(Element.prototype, name, {
      ...descriptor,
      value(this: Element, ...args: unknown[]) {
        return invoke(this, name, () => Reflect.apply(original, this, args));
      },
    });
  }
  const scroll = (event: Event) => {
    if (event.target instanceof Element && selected(event.target)) {
      const offset = event.target.scrollTop;
      remember({
        atMs: performance.now(),
        kind: "scroll",
        before: offset,
        after: offset,
        failed: false,
        stack: [],
      });
    }
  };
  document.addEventListener("scroll", scroll, true);
  const probe = {
    arm: () => {
      armed = true;
    },
    read: () => ({ records, dropped }),
    stop: () => {
      armed = false;
      document.removeEventListener("scroll", scroll, true);
      Object.defineProperty(Element.prototype, "scrollTop", top);
      for (const { name, descriptor } of methods) {
        Object.defineProperty(Element.prototype, name, descriptor);
      }
    },
  };
  Reflect.set(window, "__transcriptScrollWrites", probe);
  return probe;
}

// Preview runs execute bundled assets; resolve frames while their exact build still exists.
function mapTranscriptScrollWrites(
  writes: ReturnType<ReturnType<typeof installTranscriptScrollWriteProbe>["read"]>,
  buildRoot: string | undefined,
) {
  const maps = new Map<string, SourceMap | null>();
  return {
    ...writes,
    records: writes.records.map((record) => ({
      ...record,
      stack: record.stack.map((frame) => {
        const asset = frame.match(/^assets\/([A-Za-z0-9_-]+\.js):(\d+):(\d+)$/u);
        if (!asset) {
          return frame;
        }
        if (!buildRoot) {
          return `${frame} [no-build-root]`;
        }
        if (!maps.has(asset[1])) {
          try {
            maps.set(
              asset[1],
              new SourceMap(
                JSON.parse(readFileSync(path.join(buildRoot, "assets", `${asset[1]}.map`), "utf8")),
              ),
            );
          } catch {
            maps.set(asset[1], null);
          }
        }
        const map = maps.get(asset[1]);
        if (!map) {
          return `${frame} [map-unavailable]`;
        }
        try {
          const entry = map.findEntry(Number(asset[2]) - 1, Number(asset[3]) - 1);
          const source = entry.originalSource?.match(
            /((?:ui\/)?src\/pages\/chat\/[A-Za-z0-9_./-]+|node_modules\/@tanstack\/virtual-core\/[A-Za-z0-9_./-]+)$/u,
          )?.[1];
          if (!source || source.split("/").includes("..")) {
            return `${frame} [source-unavailable]`;
          }
          const name =
            entry.name && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(entry.name) ? ` ${entry.name}` : "";
          return `${source}:${entry.originalLine + 1}:${entry.originalColumn + 1}${name}`;
        } catch {
          return `${frame} [mapping-failed]`;
        }
      }),
    })),
  };
}

function afterTwoFrames(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function refreshedTranscriptIsAtEnd(): boolean {
  const thread = document.querySelector<HTMLElement>(".chat-thread");
  return Boolean(
    thread?.querySelector(
      '.chat-virtual-row[data-virtual-row-key="group:assistant:msg:id:active-reload-fresh-result:0"]:not([data-prepared-row])',
    ) && thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 1,
  );
}

const suite = createControlUiE2eSuite({ name: "Cached transcript text fidelity" });
const markdown = Array.from(
  { length: 24 },
  (_, index) => `- **Verification ${index + 1}** ${"Synthetic evidence. ".repeat(30)}`,
).join("\n\n");
const message = {
  role: "assistant",
  content: markdown,
  __openclaw: { id: "long-answer", seq: 1 },
};

suite.define(() => {
  it.each([
    ["reader", false, 1],
    ["end", false, 1],
    ["reader", true, 1],
    ["end", true, 1],
    ["end", false, 8],
  ] as const)(
    "keeps the cached %s stable through an active history refresh (two rounds: %s, appended pairs: %i)",
    async (anchor, twoRounds, appendedPairs) => {
      await suite.withPage(
        { serviceWorkers: "block", viewport: { width: 1720, height: 1180 } },
        async ({ page }) => {
          const sessionKey = "agent:main:chat:active-reload";
          const session = createControlUiSessionRow(sessionKey, "Synthetic active conversation", 1);
          const prefix = Array.from({ length: 12 }, (_, index) => [
            {
              role: "user",
              content: `Synthetic prompt ${index}`,
              __openclaw: { id: `prompt-${index}`, seq: index * 2 + 1 },
            },
            {
              role: "assistant",
              content: `Synthetic answer ${index}. ${"Evidence remains readable. ".repeat(12)}`,
              __openclaw: { id: `answer-${index}`, seq: index * 2 + 2 },
            },
          ]).flat();
          const fixture = createActiveTranscriptReloadFixture(prefix, appendedPairs);
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [session],
            authMethod: "trusted-proxy",
            authMode: "trusted-proxy",
            historyMessages: fixture.saved,
            deferredMethods: ["connect"],
            methodResponses: {
              "chat.message.get": { ok: true, message: fixture.fullReply },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          await page.getByText("Verification 24", { exact: true }).waitFor();
          await page.evaluate(async () => {
            const pane = document.querySelector(".chat-pane-cache__pane--active");
            await Reflect.get(pane!, "sessionSnapshotStore").flush();
          });
          await page.addInitScript({
            content: `(() => { const __name = (fn) => fn; (${installTranscriptScrollWriteProbe.toString()})(); (${installWarmReloadTranscriptProbe.toString()})(${JSON.stringify(anchor)}); })();`,
          });
          await page.reload();
          await gateway.waitForRequest("connect");
          await page.locator(".chat-thread-inner--virtual").waitFor({ state: "visible" });
          await page.waitForFunction(() => {
            if (!Reflect.get(window, "__activeTranscriptReload").ready) {
              return false;
            }
            Reflect.get(window, "__transcriptScrollWrites").arm();
            return true;
          });
          await gateway.setHistoryMessages(twoRounds ? fixture.intermediate : fixture.live);
          await gateway.resolveDeferred("connect");
          await page
            .locator('[data-position-marker-id="active-reload-fresh-result"]')
            .waitFor({ state: "attached" });
          // End-follow waits for native row measurements after the rows attach.
          if (anchor === "end" && appendedPairs === 1) {
            await page.waitForFunction(refreshedTranscriptIsAtEnd);
          }
          await page.evaluate(afterTwoFrames);
          if (twoRounds) {
            await gateway.setHistoryMessages(fixture.live);
            await gateway.emitGatewayEvent("sessions.changed", {
              sessionKey,
              agentId: "main",
              phase: "message",
            });
            await page.waitForFunction((count) => {
              const pane = document.querySelector<HTMLElement & { state: ChatPageHost }>(
                ".chat-pane-cache__pane--active",
              );
              return pane?.state.chatMessages.length === count;
            }, fixture.live.length);
            if (anchor === "end" && appendedPairs === 1) {
              await page.waitForFunction(refreshedTranscriptIsAtEnd);
            }
            await page.evaluate(afterTwoFrames);
          }
          if (appendedPairs > 1) {
            try {
              await page.waitForFunction(() => {
                const thread = document.querySelector<HTMLElement>(".chat-thread");
                return (
                  thread?.querySelector(
                    '.chat-virtual-row[data-virtual-row-key="group:assistant:msg:id:active-reload-fresh-result-7:0"]:not([data-prepared-row])',
                  ) && thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 1
                );
              });
            } catch (cause) {
              throw new Error(
                JSON.stringify(
                  await page.evaluate(() => Reflect.get(window, "__activeTranscriptReload").read()),
                ),
                { cause },
              );
            }
            await page.evaluate(afterTwoFrames);
          }
          const result: ReturnType<ReturnType<typeof installWarmReloadTranscriptProbe>["read"]> & {
            scrollWrites: ReturnType<ReturnType<typeof installTranscriptScrollWriteProbe>["read"]>;
          } = await page.evaluate(() => ({
            ...Reflect.get(window, "__activeTranscriptReload").read(),
            scrollWrites: Reflect.get(window, "__transcriptScrollWrites").read(),
          }));
          result.scrollWrites = mapTranscriptScrollWrites(
            result.scrollWrites,
            inject("controlUiE2eBuildRoot"),
          );
          const frames = result.frames;
          if (appendedPairs === 1) {
            expect(result.missingAnchorFrames).toBe(0);
          }
          const retained = frames[0]!.rows.find((row) => row.key === result.anchor)!;
          for (const frame of frames) {
            const row = frame.rows.find((item) => item.key === retained.key);
            if (row || appendedPairs === 1) {
              expect(row?.height).toBe(retained.height);
            }
          }
          if (anchor === "reader") {
            expect(
              frames.every(
                (frame) =>
                  Math.abs(
                    (frame.rows.find((item) => item.key === retained.key)?.y ?? Infinity) -
                      retained.y,
                  ) <= 1,
              ),
              JSON.stringify(result),
            ).toBe(true);
          } else {
            if (appendedPairs === 1) {
              expect(result.excessMovementPx, JSON.stringify(result)).toBe(0);
              expect(
                new Set(frames.map((frame) => frame.scrollTop)).size,
                JSON.stringify(result),
              ).toBe(twoRounds ? 3 : 2);
            } else {
              const landed = frames
                .filter((frame) => frame.distanceFromEnd <= 1)
                .flatMap((frame) =>
                  frame.rows.filter(
                    (row) => row.key === "group:assistant:msg:id:active-reload-fresh-result-7:0",
                  ),
                );
              expect(landed.length).toBeGreaterThan(0);
              expect(
                landed.every((row) => Math.abs(row.height - row.size) <= 0.5),
                JSON.stringify(result),
              ).toBe(true);
              expect(
                landed.every((row) => Math.abs(row.y - landed.at(-1)!.y) <= 1),
                JSON.stringify(result),
              ).toBe(true);
            }
            expect(
              await page
                .locator(".chat-thread")
                .evaluate((thread) => thread.scrollHeight - thread.clientHeight - thread.scrollTop),
            ).toBeLessThanOrEqual(1);
          }
        },
        async ({ page }) => {
          await page.evaluate(() => Reflect.get(window, "__transcriptScrollWrites")?.stop());
        },
      );
    },
  );
  it("keeps the complete displayed Markdown while reloading offline and reconnecting", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:chat:long-answer";
      const row = createControlUiSessionRow(sessionKey, "Synthetic long answer", 1, {
        lifecycleRevision: "revision-1",
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [row],
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        historyMessages: projectChatDisplayMessages([
          message,
          {
            role: "user",
            content: "Unrelated synthetic follow-up",
            __openclaw: { id: "follow-up", seq: 2 },
          },
        ]),
        deferredMethods: ["connect"],
        methodResponses: { "chat.message.get": { ok: true, message } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      const body = page.locator(".chat-group.assistant .chat-text");
      await body.getByText("Verification 24", { exact: true }).waitFor();
      const liveText = await body.textContent();
      await page.evaluate(async () => {
        const pane = document.querySelector(".chat-pane-cache__pane--active");
        await Reflect.get(pane!, "sessionSnapshotStore").flush();
      });
      await page.reload();
      await gateway.waitForRequest("connect");
      await body.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.screenshot({ path: path.join(suite.artifactDir, "cached.png") });
      }
      // Connect is still held: every character must come from the disk snapshot.
      expect(await body.textContent()).toBe(liveText);
      expect(await body.textContent()).not.toContain("...(truncated)...");
      const cachedHeight = await body.evaluate((element) => element.getBoundingClientRect().height);
      const followUp = page.locator('.chat-bubble[data-entry-id="follow-up"]');
      await expect.poll(() => followUp.count()).toBe(1);
      await page.locator(".agent-chat__composer-combobox textarea").focus();
      await page.keyboard.press("ControlOrMeta+f");
      const search = page.getByRole("textbox", { name: "Search loaded messages", exact: true });
      await search.fill("Verification 24");
      await expect.poll(() => followUp.count()).toBe(0);
      expect(await body.textContent()).toBe(liveText);
      await search.press("Escape");
      await expect.poll(() => search.count()).toBe(0);
      await expect.poll(() => followUp.count()).toBe(1);
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("chat.message.get");
      expect(await body.textContent()).toBe(liveText);
      expect(
        Math.abs(
          (await body.evaluate((element) => element.getBoundingClientRect().height)) - cachedHeight,
        ),
      ).toBeLessThanOrEqual(0.5);
    });
  });
});
