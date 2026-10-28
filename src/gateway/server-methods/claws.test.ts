import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawHubSourceError } from "../../claws/clawhub-source.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { clawsHandlers } from "./claws.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const listClawHubClaws = vi.hoisted(() => vi.fn());
const readClawHubClawDetail = vi.hoisted(() => vi.fn());
const readClawHubClawPreview = vi.hoisted(() => vi.fn());
vi.mock("../../claws/clawhub-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../claws/clawhub-source.js")>()),
  listClawHubClaws,
  readClawHubClawDetail,
  readClawHubClawPreview,
}));

afterEach(() => vi.clearAllMocks());

const enabled = { gateway: { controlUi: { experimental: { claws: true } } } };

async function catalogRequest(
  method: string,
  params: Record<string, unknown>,
  getRuntimeConfig: () => unknown = () => enabled,
) {
  const handler = expectDefined(clawsHandlers[method], method);
  const respond = await callAgentHandler(handler, method, params, {
    context: { getRuntimeConfig } as never,
  });
  return respond.mock.calls;
}

function expectError(replies: Parameters<RespondFn>[], code: string, message?: string) {
  expect(replies).toHaveLength(1);
  expect(replies[0]?.[2]).toMatchObject({ code, ...(message ? { message } : {}) });
}

describe("ClawHub Claw catalog Gateway methods", () => {
  const entry = { packageName: "@openclaw/workflow-operator" };
  const release = { packageName: entry.packageName, version: "1.0.0" };
  const previewParams = { ...release, kind: "instruction", name: "AGENTS.md" };
  const preview = { kind: "instruction", name: "AGENTS.md", content: "# Instructions" };

  it("rejects discovery with Labs off", async () => {
    expectError(await catalogRequest("claws.catalog.search", {}, () => ({})), "FORBIDDEN");
    expect(listClawHubClaws).not.toHaveBeenCalled();
  });

  it.each([
    ["claws.catalog.search", listClawHubClaws, {}, "entries", [entry]],
    ["claws.catalog.detail", readClawHubClawDetail, release, "detail", release],
    ["claws.catalog.preview", readClawHubClawPreview, previewParams, "preview", preview],
  ] as const)(
    "%s returns the requested result only while Labs remains enabled",
    async (method, sourceMock, params, field, result) => {
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: true,
      });
      sourceMock.mockResolvedValue(result);
      expect((await catalogRequest(method, params))[0]?.[1]).toEqual({ [field]: result });
      expect(sourceMock).toHaveBeenCalledWith(params);
      const source = createDeferredCore<unknown>();
      sourceMock.mockReturnValue(source.promise);
      let labsEnabled = true;
      const pending = catalogRequest(method, params, () => (labsEnabled ? enabled : {}));

      labsEnabled = false;
      source.resolve(result);
      expectError(await pending, "FORBIDDEN");
    },
  );

  it.each([
    ["claws.catalog.search", { query: 42 }],
    ["claws.catalog.detail", { packageName: 42 }],
    ["claws.catalog.preview", { ...release, kind: "unknown", name: "AGENTS.md" }],
  ])("rejects malformed %s before catalog I/O", async (method, params) => {
    expectError(await catalogRequest(method, params), "INVALID_REQUEST");
    expect(listClawHubClaws).not.toHaveBeenCalled();
    expect(readClawHubClawDetail).not.toHaveBeenCalled();
    expect(readClawHubClawPreview).not.toHaveBeenCalled();
  });

  it.each([
    [new ClawHubSourceError("unavailable", "Release is unavailable."), "Release is unavailable."],
    [new Error("upstream internal detail"), "ClawHub catalog is unavailable."],
  ])("preserves the public catalog failure for %s", async (failure, message) => {
    readClawHubClawDetail.mockRejectedValue(failure);
    expectError(await catalogRequest("claws.catalog.detail", release), "UNAVAILABLE", message);
  });
});
