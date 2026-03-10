import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { resetMissionControlDebStoreForTests } from "./mission-control-deb.js";
import { handleMissionControlHttpRequest } from "./mission-control.js";

async function withMissionControlServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    void handleMissionControlHttpRequest(req, res)
      .then((handled) => {
        if (handled) {
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      })
      .catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address() as AddressInfo | null;
    const port = address?.port ?? 0;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe.sequential("mission-control deb API routes", () => {
  it("serves Deb pass-1 contracts end-to-end", async () => {
    await withStateDirEnv("openclaw-mc-deb-http-", async () => {
      resetMissionControlDebStoreForTests();

      await withMissionControlServer(async (baseUrl) => {
        const profileGet = await fetch(`${baseUrl}/mission-control/api/deb/profile`);
        expect(profileGet.status).toBe(200);
        const profileInitial = (await profileGet.json()) as {
          name: string;
          role: string;
          emails: string[];
        };
        expect(profileInitial.name).toBe("Deb");

        const profilePut = await fetch(`${baseUrl}/mission-control/api/deb/profile`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Deb Ops",
            emails: ["deb@openclaw.ai"],
          }),
        });
        expect(profilePut.status).toBe(200);

        const backlogCreate = await fetch(`${baseUrl}/mission-control/api/deb/backlog`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Validate board visibility",
            section: "now",
            priority: "p1",
            status: "todo",
          }),
        });
        expect(backlogCreate.status).toBe(201);
        const created = (await backlogCreate.json()) as { id: string; status: string };
        expect(created.id.length).toBeGreaterThan(8);

        const backlogPatch = await fetch(
          `${baseUrl}/mission-control/api/deb/backlog/${created.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "done", section: "done" }),
          },
        );
        expect(backlogPatch.status).toBe(200);

        const backlogGet = await fetch(`${baseUrl}/mission-control/api/deb/backlog`);
        expect(backlogGet.status).toBe(200);
        const backlogSnapshot = (await backlogGet.json()) as {
          statusCounters: { done: number };
          priorities: { p1: number };
        };
        expect(backlogSnapshot.statusCounters.done).toBe(1);
        expect(backlogSnapshot.priorities.p1).toBe(1);

        const sprintGet = await fetch(`${baseUrl}/mission-control/api/deb/sprint`);
        expect(sprintGet.status).toBe(200);
        const sprint = (await sprintGet.json()) as {
          statusMetrics: { done: number; total: number };
        };
        expect(sprint.statusMetrics.total).toBe(1);
        expect(sprint.statusMetrics.done).toBe(1);

        const callPost = await fetch(`${baseUrl}/mission-control/api/deb/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "nudge-review",
            requestedBy: "deb-ui",
          }),
        });
        expect(callPost.status).toBe(202);
        const ack = (await callPost.json()) as { status: string; queueDepth: number };
        expect(ack.status).toBe("queued");
        expect(ack.queueDepth).toBe(1);

        const badMethod = await fetch(`${baseUrl}/mission-control/api/deb/sprint`, {
          method: "POST",
        });
        expect(badMethod.status).toBe(405);
      });
    });
  });

  it("adds Deb compatibility routes for aggregate + emails + token normalization", async () => {
    await withStateDirEnv("openclaw-mc-deb-http-compat-", async () => {
      resetMissionControlDebStoreForTests();

      await withMissionControlServer(async (baseUrl) => {
        const replaceEmails = await fetch(`${baseUrl}/mission-control/api/deb/emails`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            emails: [
              {
                label: "Daily Ops",
                email: "Ops@Bloktix.io",
                purpose: "Daily standup rollup",
              },
            ],
          }),
        });
        expect(replaceEmails.status).toBe(200);

        const listEmails = await fetch(`${baseUrl}/mission-control/api/deb/emails`);
        expect(listEmails.status).toBe(200);
        const emails = (await listEmails.json()) as Array<{ email: string; label: string }>;
        expect(emails).toHaveLength(1);
        expect(emails[0]?.email).toBe("ops@bloktix.io");

        const createBacklog = await fetch(`${baseUrl}/mission-control/api/deb/backlog`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "UI contract validation",
            section: "Sprint Cadence",
            priority: "P1",
            status: "In progress",
            owner: "Deb",
            notes: "Keep UI/API in sync",
          }),
        });
        expect(createBacklog.status).toBe(201);
        const created = (await createBacklog.json()) as {
          id: string;
          priority: string;
          status: string;
          owner: string;
          notes: string;
        };
        expect(created.priority).toBe("P1");
        expect(created.status).toBe("in-progress");

        const patchBacklog = await fetch(
          `${baseUrl}/mission-control/api/deb/backlog/${created.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "In review",
              priority: "p0",
            }),
          },
        );
        expect(patchBacklog.status).toBe(200);
        const patched = (await patchBacklog.json()) as { priority: string; status: string };
        expect(patched.priority).toBe("P0");
        expect(patched.status).toBe("in-progress");

        const aggregate = await fetch(`${baseUrl}/mission-control/api/deb`);
        expect(aggregate.status).toBe(200);
        const workspace = (await aggregate.json()) as {
          profile: { name: string };
          sprint: { sprintLabel: string };
          backlog: Array<{ id: string; priority: string; status: string }>;
          emails: Array<{ email: string }>;
        };
        expect(workspace.profile.name).toBe("Deb");
        expect(workspace.sprint.sprintLabel.length).toBeGreaterThan(0);
        expect(workspace.emails[0]?.email).toBe("ops@bloktix.io");
        expect(workspace.backlog.find((item) => item.id === created.id)?.status).toBe(
          "in-progress",
        );

        const callPost = await fetch(`${baseUrl}/mission-control/api/deb/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            instruction: "Please sync backlog lane ownership",
          }),
        });
        expect(callPost.status).toBe(202);
        const callResult = (await callPost.json()) as { ok: boolean; message: string };
        expect(callResult.ok).toBe(true);
        expect(callResult.message.toLowerCase()).toContain("queued");
      });
    });
  });
});
