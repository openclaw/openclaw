// Caller-path proof: an oversized real node-pty write that bisects an emoji at
// the scrollback cap must stay well-formed through TerminalSessionManager →
// snapshot/attach replay → terminal.text.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { terminalHandlers } from "../server-methods/terminal.js";
import { buildTerminalEnv, resolveTerminalLaunch } from "./launch.js";
import { TerminalSessionManager } from "./session-manager.js";

const SCROLLBACK_CHARS = 8;
const EMOJI = "🤖";
const EXPECTED_TAIL = "B".repeat(SCROLLBACK_CHARS - 1);

/** Payload engineered so raw `.slice(-cap)` starts on 🤖's low surrogate. */
function buildOversizedEmojiBoundaryChunk(cap: number): string {
  return `${"A".repeat(cap - 1)}${EMOJI}${"B".repeat(cap - 1)}`;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("terminal scrollback UTF-16 safety", () => {
  it.skipIf(process.platform === "win32")(
    "keeps an oversized real node-pty write on a valid UTF-16 boundary through snapshot and terminal.text",
    async () => {
      const chunk = buildOversizedEmojiBoundaryChunk(SCROLLBACK_CHARS);
      expect(chunk.length).toBe(SCROLLBACK_CHARS * 2);
      const rawTail = chunk.slice(chunk.length - SCROLLBACK_CHARS);
      expect(hasUnpairedSurrogate(rawTail)).toBe(true);
      expect(rawTail.charCodeAt(0)).toBe(0xdd16);

      const emit = vi.fn();
      const manager = new TerminalSessionManager({
        emit,
        // Production default: real @lydell/node-pty via spawnTerminalPty.
        scrollbackChars: SCROLLBACK_CHARS,
        // Keep the session alive across disconnect so attach can replay the ring.
        detachGraceMs: 60_000,
      });

      // Spawn Node itself under a real PTY so one stdout.write is the oversized
      // chunk (same boundary class as Control UI scrollback), then stay alive
      // long enough for snapshot / terminal.text / reattach.
      const outcome = await manager.open({
        connId: "conn-1",
        agentId: "main",
        cwd: process.cwd(),
        shell: process.execPath,
        args: [
          "-e",
          `process.stdout.write(${JSON.stringify(chunk)}); setTimeout(() => {}, 30_000)`,
        ],
        cols: 80,
        rows: 24,
        env: buildTerminalEnv(process.env),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }

      try {
        await vi.waitFor(
          () => {
            expect(manager.snapshot(outcome.sessionId)).toBe(EXPECTED_TAIL);
          },
          { timeout: 5_000 },
        );

        const snapshot = manager.snapshot(outcome.sessionId);
        expect(snapshot).toBeDefined();
        expect(hasUnpairedSurrogate(snapshot ?? "")).toBe(false);
        expect(snapshot?.startsWith(EMOJI)).toBe(false);
        // Confirm data crossed a real PTY onData → emit path (not a fake handle).
        expect(emit.mock.calls.some((call) => call[1] === "terminal.data")).toBe(true);

        const respond = vi.fn();
        const runtimeConfig = { gateway: { terminal: { enabled: true } } } as OpenClawConfig;
        const context = {
          getRuntimeConfig: () => runtimeConfig,
          resolveTerminalLaunchPolicy: (agentId?: string) =>
            resolveTerminalLaunch({
              config: runtimeConfig,
              enabled: true,
              agentId,
              configuredShell: undefined,
            }),
          isTerminalEnabled: () => true,
          terminalSessions: manager,
          logGateway: { info: vi.fn() },
        } as unknown as Parameters<(typeof terminalHandlers)["terminal.text"]>[0]["context"];
        await terminalHandlers["terminal.text"]({
          params: { sessionId: outcome.sessionId },
          respond,
          context,
          client: { connId: "conn-1", connect: {} },
        } as unknown as Parameters<(typeof terminalHandlers)["terminal.text"]>[0]);

        expect(respond).toHaveBeenCalledWith(true, { text: snapshot });
        const respondedText = respond.mock.calls[0]?.[1]?.text as string;
        expect(hasUnpairedSurrogate(respondedText)).toBe(false);

        manager.handleDisconnect("conn-1");
        const attached = manager.attach("conn-2", outcome.sessionId);
        expect(attached?.buffer).toBe(snapshot);
        expect(hasUnpairedSurrogate(attached?.buffer ?? "")).toBe(false);
      } finally {
        manager.close("conn-2", outcome.sessionId);
        manager.close("conn-1", outcome.sessionId);
      }
    },
  );
});
