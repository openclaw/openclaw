import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  beginUserGitLabRefresh,
  claimUserGitLabAuthorization,
  prepareUserGitLabConnection,
  readUserGitLabConnectionAsync,
  replaceUserGitLabConnection,
  settleUserGitLabRefresh,
} from "./user-gitlab-connections.js";
import { disconnectedUserGitLabConnection } from "./user-gitlab-connections.kernel.js";
import type { UserGitLabConnection } from "./user-gitlab-connections.types.js";
import { mergeProfiles } from "./user-profile-writes.worker.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const issuer = "https://gitlab.example.test";
const otherIssuer = "https://gitlab.other.test/group";
const current = () => {};

function connected(ownerIssuer = issuer): UserGitLabConnection {
  return {
    ...disconnectedUserGitLabConnection(ownerIssuer),
    selection: {
      kind: "connected",
      account: { accountId: 42, login: "alice", issuer: ownerIssuer },
      tokens: {
        accessToken: "access-original",
        refreshToken: "refresh-original",
        expiresAtMs: Date.now() + 3600000,
        scopes: ["api"],
      },
    },
  };
}

it("isolates two owners and issuers and consumes PKCE pending state before exchange", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const alice = ensureProfileForEmail("gitlab-alice@example.test").id;
    const bob = ensureProfileForEmail("gitlab-bob@example.test").id;
    const requestId = randomUUID();
    const state = "synthetic-oauth-state";
    const pending = {
      requestId,
      state,
      verifier: "synthetic-pkce-verifier",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 600000,
    };
    const first = await replaceUserGitLabConnection(
      alice,
      issuer,
      undefined,
      { ...disconnectedUserGitLabConnection(issuer), pending },
      current,
    );
    await replaceUserGitLabConnection(bob, issuer, undefined, connected(), current);
    await replaceUserGitLabConnection(
      alice,
      otherIssuer,
      undefined,
      connected(otherIssuer),
      current,
    );
    const prepared = await prepareUserGitLabConnection(alice, issuer);
    expect(prepared.read()?.pending).toEqual(pending);
    expect((await readUserGitLabConnectionAsync(bob, issuer))?.selection.kind).toBe("connected");
    expect((await readUserGitLabConnectionAsync(alice, otherIssuer))?.issuer).toBe(otherIssuer);
    expect(
      await claimUserGitLabAuthorization(
        alice,
        issuer,
        first.generation,
        requestId,
        state,
        current,
      ),
    ).toEqual(pending);
    expect(prepared.read).toThrow();
    await expect(
      claimUserGitLabAuthorization(alice, issuer, first.generation, requestId, state, current),
    ).rejects.toThrow();
    expect((await readUserGitLabConnectionAsync(alice, issuer))?.pending).toBeUndefined();
    expect((await readUserGitLabConnectionAsync(bob, issuer))?.selection.kind).toBe("connected");
  });
});

it("keeps uncertain refresh rotation blocked and rejects stale generations", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("gitlab-refresh@example.test").id;
    const original = await replaceUserGitLabConnection(
      owner,
      issuer,
      undefined,
      connected(),
      current,
    );
    const operationId = randomUUID();
    const claimed = await beginUserGitLabRefresh(
      owner,
      issuer,
      original.generation,
      operationId,
      current,
    );
    expect(claimed.selection).toMatchObject({ refresh: { operationId } });
    await expect(
      beginUserGitLabRefresh(owner, issuer, original.generation, randomUUID(), current),
    ).rejects.toThrow();
    expect(
      await settleUserGitLabRefresh(owner, issuer, operationId, {
        kind: "failed",
        failure: "failed",
      }),
    ).toBe(true);
    const failed = await readUserGitLabConnectionAsync(owner, issuer);
    expect(failed?.selection).toMatchObject({ refresh: { operationId }, refreshFailure: "failed" });
    await expect(
      beginUserGitLabRefresh(owner, issuer, failed!.generation, randomUUID(), current),
    ).rejects.toThrow();
    expect(
      await settleUserGitLabRefresh(owner, issuer, operationId, {
        kind: "rotated",
        tokens: {
          accessToken: "access-new",
          refreshToken: "refresh-new",
          expiresAtMs: Date.now() + 3600000,
          scopes: ["api"],
        },
      }),
    ).toBe(true);
    expect((await readUserGitLabConnectionAsync(owner, issuer))?.selection).toMatchObject({
      tokens: { refreshToken: "refresh-new" },
    });
    // Routine token rotation invalidates prepared reads, not the selected human account.
    expect((await readUserGitLabConnectionAsync(owner, issuer))?.generation).toBe(
      original.generation,
    );
    const disconnected = await replaceUserGitLabConnection(
      owner,
      issuer,
      original.generation,
      disconnectedUserGitLabConnection(issuer),
      current,
    );
    await expect(
      replaceUserGitLabConnection(
        owner,
        issuer,
        original.generation,
        disconnectedUserGitLabConnection(issuer),
        current,
      ),
    ).rejects.toThrow();
    expect(disconnected.selection.kind).toBe("disconnected");
  });
});

it("retires a merged profile's grant without transferring it to the target", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const source = ensureProfileForEmail("gitlab-source@example.test").id;
    const target = ensureProfileForEmail("gitlab-target@example.test").id;
    await replaceUserGitLabConnection(source, issuer, undefined, connected(), current);
    mergeProfiles(source, target);
    await expect(readUserGitLabConnectionAsync(source, issuer)).rejects.toThrow();
    expect(await readUserGitLabConnectionAsync(target, issuer)).toBeUndefined();
  });
});
