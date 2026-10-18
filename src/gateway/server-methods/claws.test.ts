import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { clawsHandlers } from "./claws.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const listClawHubClaws = vi.hoisted(() => vi.fn());
const searchClawHubClaws = vi.hoisted(() => vi.fn());
const readClawHubClawDetail = vi.hoisted(() => vi.fn());
const readClawHubClawPreview = vi.hoisted(() => vi.fn());
vi.mock("../../claws/clawhub-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../claws/clawhub-source.js")>()),
  listClawHubClaws,
  searchClawHubClaws,
  readClawHubClawDetail,
  readClawHubClawPreview,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

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
    const replies: Parameters<RespondFn>[] = [];
    await expectDefined(
      clawsHandlers["claws.catalog.search"],
      "claws.catalog.search handler",
    )({
      req: { type: "req", id: "search", method: "claws.catalog.search" },
      params: {},
      respond: (...args) => replies.push(args),
      context: { getRuntimeConfig: () => ({}) } as never,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(listClawHubClaws).not.toHaveBeenCalled();
  });

  it("lists starters and reads one exact official release with Labs on", async () => {
    listClawHubClaws.mockResolvedValue([entry]);
    readClawHubClawDetail.mockResolvedValue({
      ...entry,
      version: "1.0.0",
      workspaceFiles: 1,
      skills: 0,
      plugins: 1,
      mcpServers: 0,
      scheduledJobs: 0,
    });
    const replies: Parameters<RespondFn>[] = [];
    const context = {
      getRuntimeConfig: () => ({ gateway: { controlUi: { experimental: { claws: true } } } }),
    } as never;
    await expectDefined(
      clawsHandlers["claws.catalog.search"],
      "claws.catalog.search handler",
    )({
      req: { type: "req", id: "search", method: "claws.catalog.search" },
      params: {},
      respond: (...args) => replies.push(args),
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(replies[0]?.[1]).toEqual({ entries: [entry] });

    await expectDefined(
      clawsHandlers["claws.catalog.detail"],
      "claws.catalog.detail handler",
    )({
      req: { type: "req", id: "detail", method: "claws.catalog.detail" },
      params: { packageName: entry.packageName, version: "1.0.0" },
      respond: (...args) => replies.push(args),
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(readClawHubClawDetail).toHaveBeenCalledWith({
      packageName: entry.packageName,
      version: "1.0.0",
    });
    expect(replies[1]?.[1]).toMatchObject({ detail: { ...entry, version: "1.0.0" } });
  });

  it("returns the requested preview only for an exact official release", async () => {
    const preview = { kind: "instruction", name: "AGENTS.md", content: "# Instructions" };
    readClawHubClawPreview.mockResolvedValue(preview);
    const replies: Parameters<RespondFn>[] = [];
    const params = {
      packageName: entry.packageName,
      version: "1.0.0",
      kind: "instruction",
      name: "AGENTS.md",
    };
    await expectDefined(
      clawsHandlers["claws.catalog.preview"],
      "claws.catalog.preview handler",
    )({
      req: { type: "req", id: "preview", method: "claws.catalog.preview" },
      params,
      respond: (...args) => replies.push(args),
      context: {
        getRuntimeConfig: () => ({ gateway: { controlUi: { experimental: { claws: true } } } }),
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(readClawHubClawPreview).toHaveBeenCalledWith(params);
    expect(replies[0]?.[1]).toEqual({ preview });
  });

  it.each(["claws.catalog.search", "claws.catalog.detail"] as const)(
    "drops %s when Labs turns off during the ClawHub request",
    async (method) => {
      let resolveSource: (value: unknown) => void = () => {};
      const source = new Promise<unknown>((resolve) => {
        resolveSource = resolve;
      });
      const sourceMock =
        method === "claws.catalog.search" ? listClawHubClaws : readClawHubClawDetail;
      sourceMock.mockReturnValue(source);
      let labsEnabled = true;
      const replies: Parameters<RespondFn>[] = [];
      const request = expectDefined(
        clawsHandlers[method],
        `${method} handler`,
      )({
        req: { type: "req", id: "catalog", method },
        params:
          method === "claws.catalog.search"
            ? {}
            : { packageName: entry.packageName, version: "1.0.0" },
        respond: (...args) => replies.push(args),
        context: {
          getRuntimeConfig: () => ({
            gateway: { controlUi: { experimental: { claws: labsEnabled } } },
          }),
        } as never,
        client: null,
        isWebchatConnect: () => false,
      });

      labsEnabled = false;
      resolveSource(method === "claws.catalog.search" ? [entry] : { ...entry, version: "1.0.0" });
      await request;

      expect(replies).toHaveLength(1);
      expect(replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    },
  );
});
