import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayProtocolRequestError } from "../../packages/gateway-client/src/protocol-request.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { printRecoveryFailureDiagnostics } from "./gateway.sessions-send-recovery.diagnostics.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function writeSyntheticLog(messages: string[]): Promise<string> {
  const logPath = path.join(tempDirs.make("openclaw-recovery-diagnostic-"), "gateway.log");
  await fs.writeFile(
    logPath,
    `${messages.map((message) => JSON.stringify({ message })).join("\n")}\n`,
  );
  return logPath;
}

async function printChildLog(params: { file: string[]; console?: string[] }) {
  const output: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line) => output.push(String(line)));
  await printRecoveryFailureDiagnostics({
    client: undefined,
    databasePath: "/unused/unit117.sqlite",
    sessionKey: "unused",
    runId: undefined,
    frames: [],
    restartedLogs: (params.console ?? []).join("\n"),
    startupSnapshot: undefined,
    logPath: await writeSyntheticLog(params.file),
    markers: {},
  });
  const line = output.find((entry) => entry.startsWith("[session-recovery-child-log] "));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("[session-recovery-child-log] ".length)) as {
    console: string[];
    file: string[];
  };
}

function formattedRefusal(message: string): string {
  return formatErrorMessageWithCode(
    new GatewayProtocolRequestError({ code: "UNAVAILABLE", message }),
  );
}

function blockedLine(cause: string, ageMs: number, inputId: string): string {
  return `2026-10-22T03:00:00.000Z Chat input recovery blocked: ${cause} ${JSON.stringify({
    sessionKeyHash: "0123456789abcdef",
    inputId,
    ageMs,
  })}`;
}

it("projects only exact known recovery refusals through the failure printer", async () => {
  const known = [
    [
      "accepted chat turn recovery ownership changed; automatic retry stopped to avoid duplicate execution",
      "accepted-recovery-ownership-changed",
    ],
    ["Chat admission ended or was cancelled; submit a new turn.", "chat-admission-ended"],
    ["Chat input was not durably admitted; refresh and retry.", "input-not-durably-admitted"],
  ] as const;
  const authenticInputId = "11111111-1111-4111-8111-111111111111";
  const privateInputId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const privateToken = "Bearer unit117-private-token";
  const privatePath = "/Users/private/recovery-request.txt";
  const privateRequest = "send the private recovery request";
  const unknownCause = `${privateToken} ${privatePath} ${privateRequest} {"inputId":"${privateInputId}"} | UNAVAILABLE`;
  const nested = new GatewayProtocolRequestError({
    code: "UNAVAILABLE",
    message: known[0][0],
  });
  Object.defineProperty(nested, "cause", {
    value: new Error(`${privateToken} nested cause`),
  });

  const childLog = await printChildLog({
    console: [blockedLine(formattedRefusal(known[0][0]), 1, authenticInputId)],
    file: [
      blockedLine(formattedRefusal(known[1][0]), 2, authenticInputId),
      blockedLine(formattedRefusal(known[2][0]), 3, authenticInputId),
      blockedLine(unknownCause, 4, authenticInputId),
      blockedLine(`prefix ${formattedRefusal(known[0][0])} suffix`, 5, authenticInputId),
      blockedLine(formatErrorMessageWithCode(nested), 6, authenticInputId),
      `${blockedLine(formattedRefusal(known[0][0]), 7, authenticInputId)} malformed-tail`,
    ],
  });
  const projection = [...childLog.console, ...childLog.file].join("\n");

  for (const [, label] of known) {
    expect(projection.split(`"refusal":"${label}"`)).toHaveLength(2);
  }
  expect(projection).toContain(`"inputId":"${authenticInputId}"`);
  expect(projection).not.toContain("UNAVAILABLE");
  expect(projection).not.toContain(known[0][0]);
  expect(projection).not.toContain(privateInputId);
  expect(projection).not.toContain(privateToken);
  expect(projection).not.toContain(privatePath);
  expect(projection).not.toContain(privateRequest);
  expect(projection).not.toContain("nested cause");
});

it("keeps projected child logs within the existing line and character bounds", async () => {
  const inputId = "22222222-2222-4222-8222-222222222222";
  const longPrivateCause = `${"private-request-text-".repeat(40)} | UNAVAILABLE`;
  const childLog = await printChildLog({
    file: Array.from({ length: 45 }, (_, index) => blockedLine(longPrivateCause, index, inputId)),
  });

  expect(childLog.file).toHaveLength(40);
  expect(childLog.file.every((line) => line.length <= 500)).toBe(true);
  expect(JSON.stringify(childLog.file)).not.toContain("private-request-text");
});
