import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawHubRequestError } from "../../infra/clawhub-client.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ClawHubSourceError } from "../../templates/clawhub-source.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { templatesHandlers } from "./templates.js";
import type { RespondFn } from "./types.js";

const listClawHubTemplates = vi.hoisted(() => vi.fn());
const readClawHubTemplatesOverview = vi.hoisted(() => vi.fn());
const readClawHubTemplateDetail = vi.hoisted(() => vi.fn());
const readClawHubTemplatePreview = vi.hoisted(() => vi.fn());
vi.mock("../../templates/clawhub-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../templates/clawhub-source.js")>()),
  listClawHubTemplates,
  readClawHubTemplatesOverview,
  readClawHubTemplateDetail,
  readClawHubTemplatePreview,
}));

afterEach(() => vi.clearAllMocks());

const enabled = { gateway: { controlUi: { experimental: { templates: true } } } };
const disabled = { gateway: { controlUi: { experimental: { templates: false } } } };

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

  it("discovers Templates without a saved opt-in", async () => {
    listClawHubTemplates.mockResolvedValue([entry]);
    expect((await catalogRequest("templates.catalog.search", {}, () => ({})))[0]?.[1]).toEqual({
      entries: [entry],
    });
  });

  it("rejects discovery with Templates availability off", async () => {
    expectError(await catalogRequest("templates.catalog.search", {}, () => disabled), "FORBIDDEN");
    expect(listClawHubTemplates).not.toHaveBeenCalled();
  });

  it("requests certified category entries from ClawHub only for an opted-in overview", async () => {
    const source = await vi.importActual<typeof import("../../templates/clawhub-source.js")>(
      "../../templates/clawhub-source.js",
    );
    readClawHubTemplatesOverview.mockImplementationOnce(source.readClawHubTemplatesOverview);
    using fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        complete: true,
        completeCategoryEntries: true,
        featured: [],
        sections: [{ category: "research", items: [] }],
      }),
    );
    const replies = await catalogRequest("templates.catalog.search", {
      overview: true,
      includeCategoryEntries: true,
      limit: 3,
    });
    expect(replies[0]?.[1]).toEqual({
      entries: [],
      overview: {
        featured: [],
        sections: [{ category: "research", entries: [], additionalEntries: [] }],
      },
    });
    const request = expectDefined(fetch.mock.calls[0]?.[0], "ClawHub overview request");
    const url = new URL(request instanceof Request ? request.url : request);
    expect(url.pathname + url.search).toBe(
      "/api/v1/templates/overview?limit=3&include=categoryEntries",
    );
  });

  it.each([true, false])(
    "returns a bounded overview while Templates availability remains enabled (%s)",
    async (complete) => {
      const overview = { featured: [entry], sections: [] };
      readClawHubTemplatesOverview.mockResolvedValue(complete ? overview : undefined);
      expect(
        (await catalogRequest("templates.catalog.search", { overview: true, limit: 8 }))[0]?.[1],
      ).toEqual({
        entries: [],
        ...(complete ? { overview } : {}),
      });
      expect(listClawHubTemplates).not.toHaveBeenCalled();
      const source = createDeferredCore<unknown>();
      readClawHubTemplatesOverview.mockReturnValue(source.promise);
      let templatesEnabled = true;
      const pending = catalogRequest("templates.catalog.search", { overview: true }, () =>
        templatesEnabled ? enabled : disabled,
      );
      templatesEnabled = false;
      source.resolve(overview);
      expectError(await pending, "FORBIDDEN");
    },
  );

  it.each([
    ["templates.catalog.search", listClawHubTemplates, {}, "entries", [entry]],
    ["templates.catalog.detail", readClawHubTemplateDetail, release, "detail", release],
    ["templates.catalog.detail", readClawHubTemplateDetail, entry, "detail", release],
    ["templates.catalog.preview", readClawHubTemplatePreview, previewParams, "preview", preview],
  ] as const)(
    "%s returns the requested result only while Templates availability remains enabled",
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
      let templatesEnabled = true;
      const pending = catalogRequest(method, params, () => (templatesEnabled ? enabled : disabled));

      templatesEnabled = false;
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
    [
      new ClawHubRequestError({ path: "/api/v1/packages/missing", status: 404, body: "" }),
      "This Template is not on ClawHub. Check the name or browse the catalog.",
    ],
    [
      new ClawHubRequestError({
        path: "/api/v1/packages/agent/versions/9.9.9",
        status: 404,
        body: "",
      }),
      "This Template version is not on ClawHub. Choose another version.",
    ],
    [
      new ClawHubRequestError({ path: "/api/v1/packages/agent", status: 503, body: "" }),
      "ClawHub catalog is unavailable.",
    ],
  ])("preserves the public catalog failure for %s", async (failure, message) => {
    readClawHubTemplateDetail.mockRejectedValue(failure);
    expectError(await catalogRequest("templates.catalog.detail", release), "UNAVAILABLE", message);
  });
});
