import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawHubSourceError } from "../../claws/clawhub-source.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
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

function catalogRequest(
  method: string,
  params: Record<string, unknown>,
  getRuntimeConfig: () => unknown = () => enabled,
) {
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(clawsHandlers[method], `${method} handler`);
  const pending = handler({
    req: { type: "req", id: "catalog", method },
    params,
    respond,
    context: { getRuntimeConfig } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return { replies: respond.mock.calls, pending };
}

it("does not expose installed-Claw status as a Gateway method", () => {
  expect(coreGatewayHandlers["claws.status"]).toBeUndefined();
});

describe("ClawHub Claw catalog Gateway methods", () => {
  const entry = {
    packageName: "@openclaw/workflow-operator",
    displayName: "Workflow Operator",
    channel: "official",
    official: true,
    downloads: 0,
    updatedAtMs: 1,
  };
  const release = { packageName: entry.packageName, version: "1.0.0" };
  const previewParams = { ...release, kind: "instruction", name: "AGENTS.md" };

  it("registers read-scoped catalog methods but rejects discovery with Labs off", async () => {
    for (const method of [
      "claws.catalog.search",
      "claws.catalog.detail",
      "claws.catalog.preview",
    ] as const) {
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: true,
      });
    }
    const { replies, pending } = catalogRequest("claws.catalog.search", {}, () => ({}));
    await pending;
    expect(replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(listClawHubClaws).not.toHaveBeenCalled();
  });

  it("lists starters and reads one exact official release with Labs on", async () => {
    listClawHubClaws.mockResolvedValue([entry]);
    readClawHubClawDetail.mockResolvedValue({ ...entry, version: "1.0.0" });
    const search = catalogRequest("claws.catalog.search", {});
    await search.pending;
    expect(search.replies[0]?.[1]).toEqual({ entries: [entry] });

    const detail = catalogRequest("claws.catalog.detail", release);
    await detail.pending;
    expect(readClawHubClawDetail).toHaveBeenCalledWith(release);
    expect(detail.replies[0]?.[1]).toMatchObject({ detail: { ...entry, version: "1.0.0" } });
  });

  it("returns the requested preview only for an exact official release", async () => {
    const preview = { kind: "instruction", name: "AGENTS.md", content: "# Instructions" };
    readClawHubClawPreview.mockResolvedValue(preview);
    const params = {
      ...release,
      kind: "instruction",
      name: "AGENTS.md",
    };
    const { replies, pending } = catalogRequest("claws.catalog.preview", params);
    await pending;
    expect(readClawHubClawPreview).toHaveBeenCalledWith(params);
    expect(replies[0]?.[1]).toEqual({ preview });
  });

  it.each([
    ["claws.catalog.search", listClawHubClaws, {}, [entry]],
    ["claws.catalog.detail", readClawHubClawDetail, release, { ...entry, version: "1.0.0" }],
    ["claws.catalog.preview", readClawHubClawPreview, previewParams, { content: "# Instructions" }],
  ] as const)(
    "drops %s when Labs turns off during the ClawHub request",
    async (method, sourceMock, params, result) => {
      const source = createDeferredCore<unknown>();
      sourceMock.mockReturnValue(source.promise);
      let labsEnabled = true;
      const { replies, pending } = catalogRequest(method, params, () =>
        labsEnabled ? enabled : {},
      );

      labsEnabled = false;
      source.resolve(result);
      await pending;

      expect(replies).toHaveLength(1);
      expect(replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it.each([
    ["claws.catalog.search", { query: 42 }],
    ["claws.catalog.detail", { packageName: 42 }],
    ["claws.catalog.preview", { ...release, kind: "unknown", name: "AGENTS.md" }],
  ])("rejects malformed %s before catalog I/O", async (method, params) => {
    const { replies, pending } = catalogRequest(method, params);
    await pending;
    expect(replies).toHaveLength(1);
    expect(replies[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(listClawHubClaws).not.toHaveBeenCalled();
    expect(readClawHubClawDetail).not.toHaveBeenCalled();
    expect(readClawHubClawPreview).not.toHaveBeenCalled();
  });

  it.each([
    [new ClawHubSourceError("unavailable", "Release is unavailable."), "Release is unavailable."],
    [new Error("upstream internal detail"), "ClawHub catalog is unavailable."],
  ])("preserves the public catalog failure for %s", async (failure, message) => {
    readClawHubClawDetail.mockRejectedValue(failure);
    const { replies, pending } = catalogRequest("claws.catalog.detail", release);
    await pending;
    expect(replies).toHaveLength(1);
    expect(replies[0]?.[2]).toMatchObject({ code: "UNAVAILABLE", message });
  });
});
