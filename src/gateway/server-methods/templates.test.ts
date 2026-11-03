import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { ClawHubSourceError } from "../../templates/clawhub-source.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { templatesHandlers } from "./templates.js";
import type { RespondFn } from "./types.js";

const listClawHubTemplates = vi.hoisted(() => vi.fn());
const readClawHubTemplateDetail = vi.hoisted(() => vi.fn());
const readClawHubTemplatePreview = vi.hoisted(() => vi.fn());
vi.mock("../../templates/clawhub-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../templates/clawhub-source.js")>()),
  listClawHubTemplates,
  readClawHubTemplateDetail,
  readClawHubTemplatePreview,
}));

afterEach(() => vi.clearAllMocks());

const enabled = { gateway: { controlUi: { experimental: { templates: true } } } };

async function catalogRequest(
  method: string,
  params: Record<string, unknown>,
  getRuntimeConfig: () => unknown = () => enabled,
) {
  const handler = expectDefined(templatesHandlers[method], method);
  const respond = await callAgentHandler(handler, method, params, {
    context: { getRuntimeConfig } as never,
  });
  return respond.mock.calls;
}

function expectError(replies: Parameters<RespondFn>[], code: string, message?: string) {
  expect(replies).toHaveLength(1);
  expect(replies[0]?.[2]).toMatchObject({ code, ...(message ? { message } : {}) });
}

describe("ClawHub Template catalog Gateway methods", () => {
  const entry = { packageName: "@openclaw/workflow-operator" };
  const release = { packageName: entry.packageName, version: "1.0.0" };
  const previewParams = { ...release, kind: "instruction", name: "AGENTS.md" };
  const preview = { kind: "instruction", name: "AGENTS.md", content: "# Instructions" };

  it("rejects discovery with Labs off", async () => {
    expectError(await catalogRequest("templates.catalog.search", {}, () => ({})), "FORBIDDEN");
    expect(listClawHubTemplates).not.toHaveBeenCalled();
  });

  it.each([
    ["templates.catalog.search", listClawHubTemplates, {}, "entries", [entry]],
    ["templates.catalog.detail", readClawHubTemplateDetail, release, "detail", release],
    ["templates.catalog.preview", readClawHubTemplatePreview, previewParams, "preview", preview],
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
    ["templates.catalog.search", { query: 42 }],
    ["templates.catalog.detail", { packageName: 42 }],
    ["templates.catalog.preview", { ...release, kind: "unknown", name: "AGENTS.md" }],
  ])("rejects malformed %s before catalog I/O", async (method, params) => {
    expectError(await catalogRequest(method, params), "INVALID_REQUEST");
    expect(listClawHubTemplates).not.toHaveBeenCalled();
    expect(readClawHubTemplateDetail).not.toHaveBeenCalled();
    expect(readClawHubTemplatePreview).not.toHaveBeenCalled();
  });

  it.each([
    [new ClawHubSourceError("unavailable", "Release is unavailable."), "Release is unavailable."],
    [new Error("upstream internal detail"), "ClawHub catalog is unavailable."],
  ])("preserves the public catalog failure for %s", async (failure, message) => {
    readClawHubTemplateDetail.mockRejectedValue(failure);
    expectError(await catalogRequest("templates.catalog.detail", release), "UNAVAILABLE", message);
  });
});
