import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createMissionControlDebBacklogItem,
  createMissionControlDebCall,
  createMissionControlDebEmail,
  getMissionControlDebBacklog,
  getMissionControlDebEmails,
  getMissionControlDebProfile,
  getMissionControlDebSprint,
  getMissionControlDebWorkspace,
  parseMissionControlDebBacklogCreateInput,
  parseMissionControlDebBacklogPatchInput,
  parseMissionControlDebCallInput,
  parseMissionControlDebEmailDraftInput,
  parseMissionControlDebEmailReplaceInput,
  parseMissionControlDebProfileUpdateInput,
  removeMissionControlDebEmail,
  replaceMissionControlDebEmails,
  resetMissionControlDebStoreForTests,
  updateMissionControlDebBacklogItem,
  updateMissionControlDebEmail,
  updateMissionControlDebProfile,
} from "./mission-control-deb.js";

describe.sequential("mission-control deb store", () => {
  it("updates and persists Deb profile fields", async () => {
    await withStateDirEnv("openclaw-mc-deb-profile-", async ({ stateDir }) => {
      resetMissionControlDebStoreForTests();

      const profileBefore = getMissionControlDebProfile();
      expect(profileBefore.name).toBe("Deb");
      expect(profileBefore.emails).toEqual([]);

      const payload = parseMissionControlDebProfileUpdateInput({
        name: "Deborah",
        role: "Mission Control PM",
        photoUrl: "https://example.com/deb.png",
        emails: ["deb@example.com", "DEB@example.com", "ops@example.com"],
      });
      const updated = updateMissionControlDebProfile(payload);

      expect(updated.name).toBe("Deborah");
      expect(updated.role).toBe("Mission Control PM");
      expect(updated.photoUrl).toBe("https://example.com/deb.png");
      expect(updated.emails).toEqual(["deb@example.com", "ops@example.com"]);

      resetMissionControlDebStoreForTests();
      const reloaded = getMissionControlDebProfile();
      expect(reloaded.name).toBe("Deborah");
      expect(reloaded.emails).toEqual(["deb@example.com", "ops@example.com"]);

      const storePath = path.join(stateDir, "mission-control", "deb-store.json");
      const raw = await fs.readFile(storePath, "utf8");
      expect(raw).toContain("Deborah");
    });
  });

  it("builds grouped backlog snapshots and sprint status metrics", async () => {
    await withStateDirEnv("openclaw-mc-deb-backlog-", async () => {
      resetMissionControlDebStoreForTests();

      const alpha = createMissionControlDebBacklogItem(
        parseMissionControlDebBacklogCreateInput({
          title: "Audit sprint blockers",
          section: "now",
          priority: "p0",
          status: "in_progress",
          tags: ["sprint", "audit"],
        }),
      );
      const beta = createMissionControlDebBacklogItem(
        parseMissionControlDebBacklogCreateInput({
          title: "Draft board hygiene checklist",
          section: "next",
          priority: "p2",
          status: "todo",
        }),
      );
      const gamma = createMissionControlDebBacklogItem(
        parseMissionControlDebBacklogCreateInput({
          title: "Resolve stale blocked items",
          section: "blocked",
          priority: "p1",
          status: "blocked",
        }),
      );

      const patched = updateMissionControlDebBacklogItem(
        beta.id,
        parseMissionControlDebBacklogPatchInput({
          status: "done",
          section: "done",
          tags: ["hygiene", "completed"],
        }),
      );

      expect(patched?.status).toBe("done");
      expect(patched?.section).toBe("done");
      expect(alpha.id).not.toBe(gamma.id);

      const backlog = getMissionControlDebBacklog();
      expect(backlog.totalItems).toBe(3);
      expect(backlog.priorities).toEqual({ p0: 1, p1: 1, p2: 1, p3: 0 });
      expect(backlog.statusCounters).toEqual({
        todo: 0,
        in_progress: 1,
        blocked: 1,
        done: 1,
      });
      expect(backlog.sections.map((group) => group.section)).toEqual(["now", "blocked", "done"]);

      const sprint = getMissionControlDebSprint();
      expect(sprint.statusMetrics.total).toBe(3);
      expect(sprint.statusMetrics.inProgress).toBe(1);
      expect(sprint.statusMetrics.blocked).toBe(1);
      expect(sprint.statusMetrics.done).toBe(1);
      expect(sprint.statusMetrics.completionRate).toBeCloseTo(1 / 3, 4);
    });
  });

  it("supports aggregate workspace + email compatibility + status/priority normalization", async () => {
    await withStateDirEnv("openclaw-mc-deb-compat-", async () => {
      resetMissionControlDebStoreForTests();

      const replaced = replaceMissionControlDebEmails(
        parseMissionControlDebEmailReplaceInput({
          emails: [
            {
              label: "Daily Ops",
              email: "OPS@bloktix.io",
              purpose: "Sprint updates",
            },
          ],
        }),
      );
      expect(replaced).toHaveLength(1);
      expect(replaced[0]?.email).toBe("ops@bloktix.io");

      const createdEmail = createMissionControlDebEmail(
        parseMissionControlDebEmailDraftInput({
          label: "Release",
          email: "release@bloktix.io",
          purpose: "Release gates",
        }),
      );
      expect(createdEmail.id.length).toBeGreaterThan(8);

      const updatedEmail = updateMissionControlDebEmail(
        createdEmail.id,
        parseMissionControlDebEmailDraftInput({
          label: "Release Alerts",
          email: "release@bloktix.io",
          purpose: "Release + CI alerts",
        }),
      );
      expect(updatedEmail?.label).toBe("Release Alerts");

      const removed = removeMissionControlDebEmail(createdEmail.id);
      expect(removed).toBe(true);
      expect(getMissionControlDebEmails()).toHaveLength(1);

      const created = createMissionControlDebBacklogItem(
        parseMissionControlDebBacklogCreateInput({
          title: "Normalize board mappings",
          section: "Sprint Cadence",
          priority: "P1",
          status: "In review",
          owner: "Deb",
          notes: "Bridge UI and board status vocab",
        }),
      );
      expect(created.priority).toBe("p1");
      expect(created.status).toBe("in_progress");

      const patched = updateMissionControlDebBacklogItem(
        created.id,
        parseMissionControlDebBacklogPatchInput({
          priority: "p0",
          status: "Backlog",
        }),
      );
      expect(patched?.priority).toBe("p0");
      expect(patched?.status).toBe("todo");

      const workspace = getMissionControlDebWorkspace();
      const compatItem = workspace.backlog.find((item) => item.id === created.id);
      expect(compatItem?.priority).toBe("P0");
      expect(compatItem?.status).toBe("todo");
      expect(workspace.profile.codename).toBe("Kanban Oracle");
      expect(workspace.emails[0]?.email).toBe("ops@bloktix.io");
    });
  });

  it("queues safe call acknowledgements only", async () => {
    await withStateDirEnv("openclaw-mc-deb-call-", async () => {
      resetMissionControlDebStoreForTests();

      const ack = createMissionControlDebCall(
        parseMissionControlDebCallInput({
          instruction: "sync github project",
          requestedBy: "deb-ui",
          metadata: {
            project: "mission-control",
            dryRun: true,
          },
        }),
      );

      expect(ack.status).toBe("queued");
      expect(ack.action).toBe("sync github project");
      expect(ack.requestedBy).toBe("deb-ui");
      expect(ack.queueDepth).toBe(1);
      expect(ack.ok).toBe(true);
      expect(ack.runId).toBeNull();
      expect(ack.note.toLowerCase()).toContain("no external actions");
    });
  });
});
