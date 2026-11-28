import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as boundaryPath from "../infra/boundary-path.js";
import {
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { resolveTranscriptUpdatePathForComparison } from "./session-transcript-path.js";

const unsubscribe: Array<() => void> = [];

afterEach(() => {
  for (const stop of unsubscribe.splice(0)) {
    stop();
  }
  vi.restoreAllMocks();
});

test("shares lazy path resolution per event and retries a fallback on the next update", () => {
  const sessionFile = path.resolve("synthetic-session.jsonl");
  const resolvedFile = path.resolve("resolved-session.jsonl");
  const resolvePath = vi
    .spyOn(boundaryPath, "resolveRealpathOrAbsolute")
    .mockReturnValueOnce(sessionFile)
    .mockReturnValueOnce(resolvedFile);
  const input = { sessionFile };

  emitSessionTranscriptUpdate(input);
  const stopUnused = onInternalSessionTranscriptUpdate(() => {});
  emitSessionTranscriptUpdate(input);
  stopUnused();
  expect(resolvePath).not.toHaveBeenCalled();

  const first: Array<string | undefined> = [];
  const second: Array<string | undefined> = [];
  unsubscribe.push(
    onInternalSessionTranscriptUpdate((update) => {
      first.push(resolveTranscriptUpdatePathForComparison(update));
    }),
    onInternalSessionTranscriptUpdate((update) => {
      second.push(resolveTranscriptUpdatePathForComparison(update));
    }),
  );

  emitSessionTranscriptUpdate(input);
  expect(first).toEqual([sessionFile]);
  expect(second).toEqual(first);
  expect(resolvePath).toHaveBeenCalledTimes(1);

  emitSessionTranscriptUpdate(input);
  expect(first).toEqual([sessionFile, resolvedFile]);
  expect(second).toEqual(first);
  expect(resolvePath).toHaveBeenCalledTimes(2);

  emitSessionTranscriptUpdate({
    target: { agentId: "main", sessionId: "synthetic", sessionKey: "agent:main:synthetic" },
  });
  expect(first.at(-1)).toBeUndefined();
  expect(second.at(-1)).toBeUndefined();
  expect(resolvePath).toHaveBeenCalledTimes(2);
});
