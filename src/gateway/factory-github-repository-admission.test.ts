import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { GitHubCredentialLookupError } from "../agents/github-credential-lookup-error.js";
import type { GitHubRepositoryAdmissionRequest } from "../agents/github-credential-reader.js";
import { serializeRedactedFileLogRecord } from "../logging/redact.js";
import type { FactoryGitHubProofClaim } from "./factory-github-proof.js";
import { readFactoryRepositoryAdmission } from "./factory-github-repository-admission.js";
const logs = vi.hoisted(() => ({ info: vi.fn() }));
// mock-isolation: inspect the admission's bounded diagnostic payload without file/global log sinks.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logs }));
const claim: FactoryGitHubProofClaim = {
  purpose: "publication-preflight",
  binding: {
    kind: "session",
    agentId: "main",
    sessionKey: "session-key",
    sessionId: "session-id",
    lifecycleRevision: "revision",
  },
};
const request: GitHubRepositoryAdmissionRequest = {
  kind: "repository-admission",
  host: "microsoft.ghe.com",
  selection: {
    profileId: "ghp_6128c113c0df8c1a366dfe690c062d8e",
    kind: "app-installation",
    app: {
      appId: 13361,
      installationId: 119386,
      accountId: 185961,
      repositories: [{ id: 1044511, fullName: "bic/lobster" }],
      permissions: { contents: "write" },
      privateKey: { source: "env", provider: "default", id: "OPENCLAW_GITHUB_APP_PRIVATE_KEY" },
      keyVersion: "synthetic",
    },
  },
};
const env = {
  OPENCLAW_GATEWAY_PASSWORD: "synthetic-password",
  OPENCLAW_FACTORY_GITHUB_PROOF: "synthetic-proof",
  OPENCLAW_FACTORY_ACTOR_ID: "42",
};
function receipt() {
  return {
    version: 1,
    kind: "repository-admission",
    host: request.host,
    appId: 13361,
    installationId: 119386,
    repository: { id: 1044511, fullName: "bic/lobster" },
    actor: { accountId: 42, profileId: "original-human" },
    ...claim,
    expiresAtMs: Date.now() + 60_000,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  logs.info.mockClear();
});
describe("Factory App repository admission", () => {
  it("uses only fixed private HTTP and matches original human, installation, repository and exact binding", async () => {
    const transport = vi.fn(async () => Response.json(receipt()));
    vi.stubGlobal("fetch", transport);
    const result = await readFactoryRepositoryAdmission({
      env,
      request,
      claim,
      profileId: "original-human",
      assertCurrent: () => {},
    });
    expect(result).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toEqual([
      "http://127.0.0.1:8080/__factory__/github/repository-admission",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer synthetic-password",
          "x-factory-github-proof": "synthetic-proof",
          "x-factory-github-lookup-id": expect.stringMatching(/^[a-f0-9-]{36}$/u),
        }),
      }),
    ]);
    expect(logs.info).toHaveBeenCalledWith(
      "repository admission lookup",
      expect.objectContaining({
        lookupId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
        operation: "repository_admission",
        outcome: "resolved",
        diagnosticCode: "authorized",
        httpStatus: 200,
      }),
    );
    const text = JSON.stringify(logs.info.mock.calls);
    for (const secret of [
      "synthetic-password",
      "synthetic-proof",
      "original-human",
      "session-key",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
  it.each([true, false])(
    "accepts a slow broker only while original authority stays current (%s)",
    async (current) => {
      const controller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        setTimeout(
          () => controller.abort(new DOMException("deadline", "TimeoutError")),
          milliseconds,
        );
        return controller.signal;
      });
      const response = createDeferred<Response>();
      const transport = vi.fn(() => response.promise);
      vi.stubGlobal("fetch", transport);
      let active = true;
      const observed = readFactoryRepositoryAdmission({
        env,
        request,
        claim,
        profileId: "original-human",
        assertCurrent: () => {
          if (!active) {
            throw new Error("original owner closed");
          }
        },
      }).then(
        () => "accepted",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(9_000);
      active = current;
      response.resolve(Response.json(receipt()));
      const result = await observed;
      if (current) {
        expect(result).toBe("accepted");
      } else {
        expect(result).toMatchObject({ message: "original owner closed" });
      }
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("classifies a deadline and refuses a late valid receipt without retry", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const response = createDeferred<Response>();
    const transport = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", transport);
    const observed = readFactoryRepositoryAdmission({
      env,
      request,
      claim,
      profileId: "original-human",
      assertCurrent: () => {},
    }).catch((error: unknown) => error);
    controller.abort(new DOMException("synthetic-password", "TimeoutError"));
    response.resolve(Response.json(receipt()));
    const error = await observed;
    expect(error).toBeInstanceOf(GitHubCredentialLookupError);
    expect(error).toMatchObject({
      diagnostic: {
        clientStage: "repository_admission",
        clientCode: "deadline_exceeded",
        lookupId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      },
    });
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toContain("synthetic-password");
    const meta = logs.info.mock.calls.at(-1)?.[1];
    const redacted = serializeRedactedFileLogRecord({ "0": meta });
    expect(redacted).toContain('"diagnosticCode":"deadline_exceeded"');
    expect(redacted).not.toContain("synthetic-password");
    timeout.mockRestore();
  });
  it.each(["actor", "profile", "installation", "binding", "expired", "bearer"])(
    "refuses %s receipt",
    async (mode) => {
      const value: Record<string, unknown> = receipt();
      if (mode === "actor") {
        value.actor = { accountId: 43, profileId: "original-human" };
      }
      if (mode === "profile") {
        value.actor = { accountId: 42, profileId: "foreign-human" };
      }
      if (mode === "installation") {
        value.installationId = 1;
      }
      if (mode === "binding") {
        value.binding = { ...claim.binding, sessionId: "replacement" };
      }
      if (mode === "expired") {
        value.expiresAtMs = Date.now();
      }
      if (mode === "bearer") {
        value.token = "synthetic-human-bearer";
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(value)),
      );
      await expect(
        readFactoryRepositoryAdmission({
          env,
          request,
          claim,
          profileId: "original-human",
          assertCurrent: () => {},
        }),
      ).rejects.toMatchObject({
        diagnostic: {
          clientStage: "repository_admission",
          clientCode:
            mode === "bearer"
              ? "invalid_receipt"
              : mode === "expired"
                ? "receipt_expired"
                : "binding_mismatch",
        },
      });
    },
  );
  it("refuses late original authority and redacts transport failure", async () => {
    let current = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        current = false;
        return Response.json(receipt());
      }),
    );
    const assertCurrent = () => {
      if (!current) {
        throw new Error("original owner closed");
      }
    };
    await expect(
      readFactoryRepositoryAdmission({
        env,
        request,
        claim,
        profileId: "original-human",
        assertCurrent,
      }),
    ).rejects.toThrow("original owner closed");
    current = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("synthetic-password synthetic-proof");
      }),
    );
    await expect(
      readFactoryRepositoryAdmission({
        env,
        request,
        claim,
        profileId: "original-human",
        assertCurrent,
      }),
    ).rejects.toMatchObject({ diagnostic: { clientCode: "transport_error" } });
  });
});
