import { assert, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  callGatewayMock,
  executeCron,
  installCronToolTestFixture,
  readGatewayCall,
} from "./cron-tool.test-support.js";

installCronToolTestFixture();

const creator = {
  agentSessionKey: "agent:main:main",
  creatorToolAllowlist: ["execute_code", "read", "write"],
  creatorToolAllowlistCaptureRef: {
    value: { version: 1 as const, source: "final-executable-surface" as const },
  },
};

function job(toolsAllow: string[] | undefined = ["execute_code"]) {
  return {
    name: "Reference lookup",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Read the installed reference.", toolsAllow },
  };
}

it.each(["add", "update"] as const)(
  "adds configured tools before the %s request reaches publication",
  async (action) => {
    setRuntimeConfigSnapshot({ cron: { defaultTools: ["read", "read"] } });
    const input = { action, id: "routine", job: job() };
    const original = structuredClone(input);
    if (action === "update") {
      callGatewayMock.mockResolvedValueOnce({
        ...job(),
        payload: { ...job().payload, message: "Previous instructions" },
      });
    }
    await executeCron(input, creator);
    expect(input).toEqual(original);
    const request = readGatewayCall(action === "update" ? 1 : 0);
    expect(request.method).toBe(`cron.${action}`);
    const shape = action === "add" ? request.params : request.params?.patch;
    expect(shape).toMatchObject({ payload: { toolsAllow: ["execute_code", "read"] } });
    expect(shape).not.toHaveProperty("payload.toolsAllowIsDefault");
    expect(shape).not.toHaveProperty("toolsAllowMode");
  },
);

it.each([
  { action: "add", mode: "exact", toolsAllow: ["execute_code"] },
  { action: "update", mode: "exact", toolsAllow: ["execute_code"] },
  { action: "add", mode: undefined, toolsAllow: [] },
  { action: "update", mode: undefined, toolsAllow: [] },
])("preserves the explicit restriction %j", async ({ action, mode, toolsAllow }) => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  await executeCron({ action, id: "routine", toolsAllowMode: mode, job: job(toolsAllow) }, creator);
  const shape = action === "add" ? readGatewayCall().params : readGatewayCall().params?.patch;
  expect(shape).toMatchObject({ payload: { toolsAllow } });
  if (mode === "exact") {
    expect(shape).toHaveProperty("payload.toolsAllowMode", "exact");
  }
  expect(readGatewayCall().params).not.toHaveProperty("toolsAllowMode");
});

it.each(["add", "update"] as const)(
  "keeps a flat %s opt-out out of the published shape",
  async (action) => {
    setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
    const input = { action, id: "routine", toolsAllowMode: "exact", ...job() };
    const original = structuredClone(input);
    await executeCron(input, creator);
    const request = readGatewayCall();
    const shape = action === "add" ? request.params : request.params?.patch;
    expect(shape).toMatchObject({ payload: { toolsAllow: ["execute_code"] } });
    expect(shape).not.toHaveProperty("toolsAllowMode");
    expect(request.params).not.toHaveProperty("toolsAllowMode");
    expect(input.payload).toEqual(original.payload);
  },
);

it("keeps creation unchanged when defaults are not configured", async () => {
  await executeCron({ action: "add", job: job() }, creator);
  expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: ["execute_code"] } });
});

it("keeps an omitted selection on the native default policy", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  const input = {
    ...job(),
    payload: { kind: "agentTurn", message: "Use the native default policy." },
  };
  await executeCron({ action: "add", job: input }, creator);
  expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: ["*"] } });
});

it("rejects an invalid opt-out mode before publishing a selection", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  await expect(
    executeCron({ action: "add", toolsAllowMode: "restricted", job: job() }, creator),
  ).rejects.toThrow('toolsAllowMode must be "exact", "defaults", or omitted');
  expect(callGatewayMock).not.toHaveBeenCalled();
});

it.each([
  { storedMode: undefined, requestedMode: undefined, changed: false, expected: ["execute_code"] },
  { storedMode: "exact", requestedMode: undefined, changed: true, expected: ["execute_code"] },
  {
    storedMode: "exact",
    requestedMode: "defaults",
    changed: false,
    expected: ["execute_code", "read"],
  },
] as const)(
  "preserves copied selections and explicitly resets exact: %j",
  async ({ storedMode, requestedMode, changed, expected }) => {
    setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
    const stored = {
      ...job(),
      payload: { ...job().payload, ...(storedMode ? { toolsAllowMode: storedMode } : {}) },
    };
    callGatewayMock.mockImplementation(async ({ method }) =>
      method === "cron.get" ? stored : { ok: true },
    );
    const patch = {
      ...job(),
      name: "Renamed",
      payload: { ...job().payload, message: changed ? "New instructions" : job().payload.message },
    };
    await executeCron(
      { action: "update", id: "routine", toolsAllowMode: requestedMode, job: patch },
      creator,
    );
    const request = callGatewayMock.mock.calls
      .map(([value]) => value)
      .find(({ method }) => method === "cron.update");
    assert(request, "cron.update must publish the prepared selection");
    expect(request.params.patch.payload).toMatchObject({ toolsAllow: expected });
    expect(request.params.patch.payload.toolsAllowMode).toBe(requestedMode ?? storedMode);
    expect(stored.payload.toolsAllow).toEqual(["execute_code"]);
  },
);

it("prepares a defaults reset against the current saved selection when the payload is omitted", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  callGatewayMock.mockResolvedValueOnce({
    ...job(),
    payload: { ...job().payload, toolsAllowMode: "exact" },
  });
  await executeCron(
    { action: "update", id: "routine", toolsAllowMode: "defaults", job: {} },
    creator,
  );
  expect(readGatewayCall(1)).toMatchObject({
    method: "cron.update",
    params: {
      expectedConfigRevision: "sha256:test",
      patch: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["execute_code", "read"],
          toolsAllowMode: "defaults",
        },
      },
    },
  });
});

it("does not add tools to a revision that leaves the saved tool selection alone", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  await executeCron({ action: "update", id: "routine", job: { name: "Renamed" } }, creator);
  expect(readGatewayCall()).toEqual({
    method: "cron.update",
    params: { id: "routine", patch: { name: "Renamed" } },
  });
});

it("does not grant a configured default outside the creator's executable surface", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  await expect(
    executeCron(
      { action: "add", job: job() },
      { ...creator, creatorToolAllowlist: ["execute_code"] },
    ),
  ).rejects.toThrow('Requested automation tool "read" cannot be carried');
  expect(callGatewayMock).not.toHaveBeenCalled();
});
