import { readdirSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import type { Page } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import {
  installTalkPerfFixture,
  launchTalkObservationBrowser,
} from "../../scripts/lib/control-ui-talk-fixture.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("rejects a missing browser executable and reclaims its temporary profile", async () => {
  const artifacts = tempDirs.make("openclaw-talk-browser-");
  vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", path.join(artifacts, "missing-chromium"));

  await expect(launchTalkObservationBrowser(artifacts, true)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(readdirSync(artifacts)).toEqual([]);
}, 5_000);

it("stops cancelled relay output while a stale cancellation leaves the live turn running", async () => {
  vi.useFakeTimers();
  const events: Array<{ type: string; talkEvent?: { turnId?: string; type?: string } }> = [];
  let initializer = "";
  let fixtureArgs: unknown;
  const disposable = {
    async dispose() {},
    async [Symbol.asyncDispose]() {},
  };
  // The fixture installs only an init script and this route; no browser is required for its timer contract.
  const page = {
    addInitScript: async (script: unknown, args?: unknown) => {
      initializer = String(script);
      fixtureArgs = args;
      return disposable;
    },
    route: async () => disposable,
  } satisfies Pick<Page, "addInitScript" | "route">;
  class AudioNode {
    frequency = { value: 0 };
    gain = { value: 0 };
    connect() {
      return this;
    }
    start() {}
    stop() {}
  }
  class AudioContext {
    createOscillator() {
      return new AudioNode();
    }
    createGain() {
      return new AudioNode();
    }
    createMediaStreamDestination() {
      return { stream: { getTracks: () => [] } };
    }
    createScriptProcessor() {}
    async resume() {}
  }
  class AudioBufferSourceNode {
    start() {}
    stop() {}
  }
  class HTMLMediaElement {
    async play() {}
  }
  class AnalyserNode {
    getFloatTimeDomainData() {}
  }
  const context = createContext({
    AudioContext,
    AudioBufferSourceNode,
    HTMLMediaElement,
    AnalyserNode,
    EventTarget,
    Event,
    MessageEvent,
    performance,
    btoa,
    navigator: { mediaDevices: {} },
    document: { removeEventListener() {} },
    setTimeout,
    clearTimeout,
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    openclawControlUiE2eGateway: {
      emit: (_name: string, event: (typeof events)[number]) => events.push(event),
    },
  });
  context.window = context;
  await installTalkPerfFixture(page, false, false, "gateway-relay");
  context.fixtureArgs = fixtureArgs;
  runInContext(`(${initializer})(fixtureArgs)`, context);
  await runInContext("navigator.mediaDevices.getUserMedia()", context);
  const proof = context.openclawTalkBench as Window["openclawTalkBench"];
  proof.setState("responding");
  const turnId = events[0]?.talkEvent?.turnId;
  expect(turnId).toBeTypeOf("string");

  expect(
    proof.cancelOutput({ sessionId: "relay-bench", turnId: "older-turn", reason: "barge-in" }),
  ).toEqual({ ok: true, status: "stale" });
  await vi.advanceTimersByTimeAsync(100);
  expect(events.filter((event) => event.type === "audio")).toHaveLength(2);

  expect(proof.cancelOutput({ sessionId: "relay-bench", turnId, reason: "barge-in" })).toEqual({
    ok: true,
    status: "applied",
    turnId,
  });
  expect(events.at(-1)).toMatchObject({
    type: "clear",
    talkEvent: { turnId, type: "turn.cancelled" },
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(events.filter((event) => event.type === "audio")).toHaveLength(2);
  expect(proof.cancelOutput({ sessionId: "relay-bench", turnId })).toEqual({
    ok: true,
    status: "idle",
  });
  expect(proof.readPcm().cancellations.map(({ status, reason }) => ({ status, reason }))).toEqual([
    { status: "stale", reason: "barge-in" },
    { status: "applied", reason: "barge-in" },
    { status: "idle", reason: undefined },
  ]);
});
