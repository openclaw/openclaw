import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGitHubToolIdentityStatus } from "../agents/github-tool-identity.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareGatewayProjectGitHubIdentity } from "./project-github-identity.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./server-methods/core-handlers.js";
import type { GatewayClient } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";

const catalog = vi.hoisted(() => ({ emails: ["github:engineering.ghe.com:42"] }));
// Resident catalog facts replace storage only; all admission decisions remain production code.
vi.mock("../state/user-profile-list.js", async (original) => ({
  ...(await original<typeof import("../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: () => ({
    readCurrentFacts: () => ({ profileId: "person-1", emails: catalog.emails }),
  }),
}));

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const host = "engineering.ghe.com";
const apiBaseUrl = `https://api.${host}`;
const admissionPath = "/__factory__/github/repository-admission";
const admissionRequest = `GET ${admissionPath}`;
const issueUrl = `${apiBaseUrl}/repos/example/project/issues/1`;
const claim = {
  purpose: "session-item-read" as const,
  binding: {
    kind: "session" as const,
    agentId: "main",
    sessionKey: "agent:main:room",
    sessionId: "session-1",
    lifecycleRevision: "revision-1",
    requestDigest: "synthetic-item-digest",
  },
};
const permissions = { contents: "read" as const, metadata: "read" as const };
function client(): GatewayClient {
  return {
    connId: "human-connection",
    authenticatedFactoryGitHubAccountId: 42,
    authenticatedUserId: `github:${host}:42`,
    authenticatedUserProfile: gatewayProfile("person-1"),
    connect: gatewayConnect(["operator.read"], { id: "cli", mode: "cli" }),
    internal: { authenticatedOperator: true },
  };
}

let config: OpenClawConfig;
let active: boolean;
let deny: boolean;
let receiptPatch: Record<string, unknown>;
let onRequest: ((path: string) => void) | undefined;
let requests: string[];
let brokerVerdict: unknown;
let cleanupFails: boolean;
const assertActive = () => {
  if (!active) {
    throw new Error("Session authority retired");
  }
};

async function redeem(proof: string) {
  const respond = vi.fn();
  const broker = client();
  broker.connId = "broker-connection";
  broker.connect.scopes = ["operator.admin"];
  broker.internal = {
    authenticatedOperator: true,
    isLocalClient: true,
    operatorRoleActor: { kind: "system" },
  };
  await coreGatewayHandlers["factory.githubPublication.redeem"]?.({
    client: broker,
    context: createDirectChatContext({ isConnectionActive: () => true }),
    req: { type: "req", id: "redeem-1", method: "factory.githubPublication.redeem" },
    params: { proof },
    respond,
    isWebchatConnect: () => false,
    hasCurrentClientAuthority: () => true,
  });
  const result = respond.mock.calls[0];
  if (result?.[0] !== true) {
    throw new Error("Broker proof rejected");
  }
  brokerVerdict = result[1];
  return result[1];
}

function prepare(caller = client(), requestedRepository?: string) {
  return prepareGatewayProjectGitHubIdentity({
    agentId: "main",
    config,
    context: { getRuntimeConfig: () => config },
    client: caller,
    requestedRepository,
    assertActive,
    factoryCredential: { claim: structuredClone(claim), assertCurrent: assertActive },
  });
}

function readIssue(identity: NonNullable<Awaited<ReturnType<typeof prepare>>>) {
  return identity.start(() =>
    fetch(issueUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${identity.token}` },
    }),
  );
}

beforeEach(() => {
  active = true;
  deny = false;
  cleanupFails = false;
  receiptPatch = {};
  requests = [];
  brokerVerdict = undefined;
  onRequest = undefined;
  catalog.emails = [`github:${host}:42`];
  config = {
    gateway: { github: { host, apiBaseUrl } },
    tools: {
      github: {
        kind: "app-installation",
        profileId: "ghp_00000000000000000000000000000001",
        app: {
          appId: 101,
          installationId: 202,
          accountId: 303,
          repositories: [{ id: 404, fullName: "example/project" }],
          permissions,
          privateKey,
          keyVersion: "synthetic-v1",
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "synthetic-broker-password");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = url.startsWith(apiBaseUrl) ? url.slice(apiBaseUrl.length) : new URL(url).pathname;
    requests.push(`${init.method} ${path}`);
    onRequest?.(path);
    if (path === admissionPath) {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer synthetic-broker-password");
      const verdict = await redeem(headers.get("x-factory-github-proof") ?? "");
      if (deny) {
        return new Response(null, { status: 403 });
      }
      return Response.json({
        version: 1,
        kind: "repository-admission",
        host,
        appId: 101,
        installationId: 202,
        repository: { id: 404, fullName: "example/project" },
        actor: { accountId: verdict.actorId, profileId: verdict.profileId },
        purpose: verdict.purpose,
        binding: verdict.binding,
        expiresAtMs: Date.now() + 30_000,
        ...receiptPatch,
      });
    }
    if (init.method === "DELETE") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-app-token");
      return new Response(null, { status: cleanupFails ? 503 : 204 });
    }
    const bodies: Record<string, unknown> = {
      "/app": { id: 101, slug: "factory", permissions },
      "/app/installations/202": {
        id: 202,
        app_id: 101,
        account: { id: 303 },
        suspended_at: null,
        permissions,
      },
      "/app/installations/202/access_tokens": {
        token: "synthetic-app-token",
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions,
      },
      "/users/factory%5Bbot%5D": { id: 9001, login: "factory[bot]", type: "Bot", avatar_url: null },
      "/installation/repositories?per_page=100": {
        total_count: 1,
        repositories: [{ id: 404, full_name: "example/project" }],
      },
      "/repos/example/project/issues/1": { title: "Private issue" },
    };
    if (!(path in bodies)) {
      throw new Error(`Unexpected external request: ${path}`);
    }
    if (path.endsWith("/access_tokens")) {
      if (typeof init.body !== "string") {
        throw new Error("Missing App token request body");
      }
      expect(JSON.parse(init.body)).toEqual({ repository_ids: [404], permissions });
    }
    if (path === "/repos/example/project/issues/1") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-app-token");
    }
    return Response.json(bodies[path]);
  });
});

afterEach(() => {
  setRuntimeConfigSnapshot({});
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Factory project read admission composition", () => {
  function configureMultipleRepositories() {
    const selected = config.tools?.github;
    if (selected?.kind !== "app-installation") {
      throw new Error("Expected App fixture");
    }
    selected.app.repositories.unshift({ id: 405, fullName: "example/other" });
    return selected;
  }

  it.each(["unconfigured", "wrong admission"])(
    "refuses a multi-repository read with %s repository before minting",
    async (failure) => {
      configureMultipleRepositories();
      if (failure === "wrong admission") {
        receiptPatch.repository = { id: 405, fullName: "example/other" };
      }
      await expect(
        prepare(client(), failure === "unconfigured" ? "example/missing" : "example/project"),
      ).rejects.toThrow(
        failure === "unconfigured" ? "unavailable" : "Factory repository admission failed",
      );
      expect(requests).toEqual(failure === "unconfigured" ? [] : [admissionRequest]);
    },
  );

  it.each(["admission", "read"])(
    "retires a narrowed grant when the full configured selection changes during %s",
    async (phase) => {
      const selected = configureMultipleRepositories();
      const changeOtherRepository = () => {
        selected.app.repositories[0]!.id = 406;
      };
      if (phase === "admission") {
        onRequest = (path) => {
          if (path === admissionPath) {
            changeOtherRepository();
          }
        };
        await expect(prepare(client(), "example/project")).rejects.toThrow("changed");
        expect(requests).toEqual([admissionRequest]);
        return;
      }
      const identity = await prepare(client(), "example/project");
      const app = {
        ...selected.app,
        repositories: [
          { id: 406, fullName: "example/other" },
          { id: 404, fullName: "example/project" },
        ],
      };
      config = { ...config, tools: { github: { ...selected, app } } };
      setRuntimeConfigSnapshot(config);
      try {
        await expect(identity!.start(() => fetch(issueUrl))).rejects.toThrow("changed");
        expect(requests.some((request) => request.includes("/issues/"))).toBe(false);
      } finally {
        await identity?.revoke?.();
      }
      expect(requests.at(-1)).toBe("DELETE /installation/token");
    },
  );

  it.each([false, true])(
    "admits an exact App grant, reads, and closes custody (multiple repositories: %s)",
    async (multiple) => {
      if (multiple) {
        configureMultipleRepositories();
      }
      const identity = await prepare(client(), multiple ? "Example/Project" : undefined);
      expect(brokerVerdict).toEqual({
        version: 1,
        audience: "lobster.github.system-token",
        actorId: 42,
        actorPrincipal: `github:${host}:42`,
        profileId: "person-1",
        ...claim,
      });
      expect(identity).toBeDefined();
      const response = await readIssue(identity!);
      expect(await response.json()).toEqual({ title: "Private issue" });
      expect(
        (
          await resolveGitHubToolIdentityStatus({
            config,
            agentId: "main",
            selectedScope: "system",
          })
        ).effective,
      ).toMatchObject({ credentialState: "available", account: { login: "factory[bot]" } });
      await identity!.revoke?.();
      await expect(identity!.revalidate()).rejects.toThrow("changed");
      expect(requests[0]).toBe(admissionRequest);
      expect(requests.at(-1)).toBe("DELETE /installation/token");
    },
  );

  it.each([
    ["denied", {}],
    ["foreign repository", { repository: { id: 405, fullName: "other/project" } }],
    ["foreign host", { host: "other.ghe.com" }],
    ["actor mismatch", { actor: { accountId: 43, profileId: "person-1" } }],
  ] as const)("rejects %s admission before any App token request", async (failure, patch) => {
    deny = failure === "denied";
    Object.assign(receiptPatch, patch);
    await expect(prepare()).rejects.toThrow("Factory repository admission failed");
    expect(requests).toEqual([admissionRequest]);
  });

  it("rejects a handshake actor that disagrees with the current profile before contacting the broker", async () => {
    catalog.emails = [`github:${host}:43`];
    await expect(prepare()).rejects.toThrow("actor profile changed");
    expect(requests).toEqual([]);
  });

  it("rejects a handshake from another Enterprise host even when the account ID matches", async () => {
    const caller = client();
    caller.authenticatedUserId = "github:previous.ghe.com:42";
    await expect(prepare(caller)).rejects.toThrow("caller authority changed");
    expect(requests).toEqual([]);
  });

  it.each([admissionPath, "/app/installations/202/access_tokens"])(
    "retirement during %s prevents a usable credential and cleans up any issued token",
    async (path) => {
      onRequest = (current) => {
        if (current === path) {
          active = false;
        }
      };
      await expect(prepare()).rejects.toThrow("Session authority retired");
      expect(requests.some((request) => request.includes("/issues/"))).toBe(false);
      expect(requests.includes("DELETE /installation/token")).toBe(path.endsWith("/access_tokens"));
    },
  );

  it("rejects private reads after the prepared human principal is retired and still revokes the App token", async () => {
    const identity = await prepare();
    catalog.emails = [];
    try {
      await expect(readIssue(identity!)).rejects.toThrow(
        "GitHub actor binding is unavailable or ambiguous",
      );
      expect(requests.some((request) => request.includes("/issues/"))).toBe(false);
    } finally {
      await identity!.revoke?.();
    }
    expect(requests.at(-1)).toBe("DELETE /installation/token");
  });

  it("surfaces cleanup failure and closes the read identity before retrying any read", async () => {
    const identity = await prepare();
    cleanupFails = true;
    await expect(identity!.revoke!()).rejects.toThrow("revocation failed");
    await expect(identity!.revalidate()).rejects.toThrow("changed");
  });
});
