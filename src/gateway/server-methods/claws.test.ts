import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it.each(["claws.catalog.search", "claws.catalog.detail"] as const)(
    "drops %s when Labs turns off during the ClawHub request",
    async (method) => {
      const source = createDeferredCore<unknown>();
      const sourceMock =
        method === "claws.catalog.search" ? listClawHubClaws : readClawHubClawDetail;
      sourceMock.mockReturnValue(source.promise);
      let labsEnabled = true;
      const { replies, pending } = catalogRequest(
        method,
        method === "claws.catalog.search" ? {} : release,
        () => (labsEnabled ? enabled : {}),
      );

      labsEnabled = false;
      source.resolve(method === "claws.catalog.search" ? [entry] : { ...entry, version: "1.0.0" });
      await pending;

      expect(replies).toHaveLength(1);
      expect(replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    },
  );
});
