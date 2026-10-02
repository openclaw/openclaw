import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectClawsStatus } from "../../claws/gateway-status-projection.js";
import type { ClawStatusRecord } from "../../claws/lifecycle-state.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { clawsHandlers } from "./claws.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const readClawStatusForGateway = vi.hoisted(() => vi.fn());
const listClawHubClaws = vi.hoisted(() => vi.fn());
const searchClawHubClaws = vi.hoisted(() => vi.fn());
const readClawHubClawDetail = vi.hoisted(() => vi.fn());
vi.mock("../../claws/gateway-status-worker.js", () => ({ readClawStatusForGateway }));
vi.mock("../../claws/clawhub-source.js", () => ({
  ClawHubSourceError: class ClawHubSourceError extends Error {},
  listClawHubClaws,
  searchClawHubClaws,
  readClawHubClawDetail,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("claws.status Gateway method", () => {
  it("is registered for read-scoped operators", () => {
    expect(coreGatewayHandlers["claws.status"]).toBeDefined();
    expect(authorizeOperatorScopesForMethod("claws.status", [])).toEqual({
      allowed: false,
      missingScope: "operator.read",
    });
    expect(authorizeOperatorScopesForMethod("claws.status", ["operator.read"])).toEqual({
      allowed: true,
    });
  });

  it("keeps installed Claws visible with Labs off without exposing source or prompt data", async () => {
    const record = {
      install: {
        claw: {
          kind: "package",
          name: "@openclaw/workflow-operator",
          version: "1.0.0",
          packageRoot: "/private/source",
          manifestPath: "/private/source/CLAW.md",
          integrity: "sha256:secret-artifact",
        },
        agentId: "workflow-operator",
        workspace: "/private/workspace",
        status: "complete",
        addedAtMs: 1,
        updatedAtMs: 2,
      },
      agentState: "present",
      bootstrapState: "complete",
      workspaceFiles: [{ path: "SOUL.md", state: "unchanged", source: "/private/source" }],
      packages: [
        {
          kind: "plugin",
          ref: "@openclaw/workflow-tools",
          version: "1.0.0",
          state: "present",
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
          integrity: "sha256:secret-plugin",
        },
      ],
      mcpServers: [],
      cronJobs: [{ manifestId: "daily", status: "complete", job: { message: "private prompt" } }],
    } as unknown as ClawStatusRecord;
    const projected = projectClawsStatus([record]);
    readClawStatusForGateway.mockResolvedValue(projected);
    const replies: Parameters<RespondFn>[] = [];
    const config = { gateway: { controlUi: { experimental: { claws: false } } } };

    await expectDefined(
      clawsHandlers["claws.status"],
      "claws.status handler",
    )({
      req: { type: "req", id: "status", method: "claws.status" },
      params: {},
      respond: (...args) => replies.push(args),
      context: { getRuntimeConfig: () => config } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.[0]).toBe(true);
    expect(replies[0]?.[1]).toMatchObject({
      summary: { claws: 1, managed: 4 },
      records: [{ agentId: "workflow-operator", status: "complete" }],
    });
    expect(readClawStatusForGateway).toHaveBeenCalledWith(
      expect.objectContaining({ config, target: undefined, listCronJobs: expect.any(Function) }),
    );
    const payload = JSON.stringify(replies[0]?.[1]);
    expect(payload).not.toContain("/private/");
    expect(payload).not.toContain("sha256:secret");
    expect(payload).not.toContain("private prompt");
  });
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
    for (const method of ["claws.catalog.search", "claws.catalog.detail"] as const) {
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
