// Install shared transport mocks before publication owners enter the module cache.
import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
// oxfmt-ignore
import { installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { registerPublicationCredentialFixture } from "./github-publication-credential.test-helpers.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import {
  createRequesterPolicyFixture,
  publicationGuestEmail as email,
} from "./github-publication-requester.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

describe("local production-owner proof", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: email,
    sandbox: "required",
    realWorktree: true,
  });
  it.each(["allowed", "revoked", "reassigned"] as const)(
    "qualifies credential-before-network authority with real owners: %s",
    async (scenario) => {
      const f = await createRequesterPolicyFixture();
      const identity = { ...f.session, agentId: "main" };
      const placements = createWorkerSessionPlacementStore({ database: f.database });
      const events: string[] = [];
      const synthetic = registerPublicationCredentialFixture(f, events);
      const server = createServer((req, res) => {
        events.push("network");
        expect(req.headers.authorization).toBe("Bearer " + synthetic);
        res.end("ok");
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback address");
      }

      try {
        if (scenario === "revoked") {
          await f.revoke();
        }
        if (scenario === "reassigned") {
          await placements.startDispatch({ ...identity, agentId: "other-agent" });
        }
        const run = placements.withRepositoryWorkspaceReservation(
          identity,
          async (assertPlacementCurrent) => {
            events.push("placement-admitted");
            const read = f.guest.prepareDispatchCredential!({
              sessionId: identity.sessionId,
              requestDigest: "local-proof",
              assertCurrent: assertPlacementCurrent,
            });
            expect(read).toBeTypeOf("function");
            const credential = await read!({});
            await new Promise<void>((resolve, reject) => {
              const req = httpRequest(
                {
                  host: "127.0.0.1",
                  port: address.port,
                  headers: { authorization: "Bearer " + credential },
                },
                (res) => {
                  res.resume();
                  res.on("end", resolve);
                },
              );
              req.setTimeout(5000, () => req.destroy(new Error("Loopback sink timed out")));
              req.on("error", reject);
              req.end();
            });
          },
        );
        if (scenario === "allowed") {
          await run;
          expect(events).toEqual([
            "placement-admitted",
            "integration-admitted",
            "credential",
            "network",
          ]);
        } else {
          if (scenario === "reassigned") {
            await expect(run).rejects.toThrow("workspace placement identity changed");
          } else {
            await expect(run).rejects.toBeInstanceOf(GitHubPublicationRequesterUnavailableError);
          }
          expect(events).not.toContain("credential");
          expect(events).not.toContain("network");
          expect(events).not.toContain("integration-admitted");
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    },
  );
});
