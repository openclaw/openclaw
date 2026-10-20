import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Welcome personal recent chats" });
const openPage = createPageOpener(suite);
const actor = (id: string) => ({
  type: "human" as const,
  id,
  identity: { type: "profile" as const, id },
});
const row = (id: string, label: string, recency: number): GatewaySessionRow => ({
  key: "agent:main:dashboard:" + id,
  sessionId: id,
  kind: "direct",
  label,
  updatedAt: Date.now() - (2000 - recency) * 60_000,
});
const result = (sessions: GatewaySessionRow[]) => ({
  ts: Date.now(),
  path: "",
  count: sessions.length,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  sessions,
});

suite.define(() => {
  it.each([
    { viewer: "alice", surface: "new" },
    { viewer: "alice", surface: "empty-chat" },
    { viewer: "bob", surface: "new" },
    { viewer: "bob", surface: "empty-chat" },
  ])(
    "shows $viewer’s Gateway involvement on $surface without narrowing discovery",
    async ({ viewer, surface }) => {
      const page = await openPage({ viewport: { width: 1280, height: 900 } });
      const other = viewer === "alice" ? "bob" : "alice";
      const ownTitle = viewer === "alice" ? "Alice’s planning notes" : "Bob’s planning notes";
      const owned = { ...row(viewer + "-owned", ownTitle, 30), owner: { actor: actor(viewer) } };
      const prompted = {
        ...row("shared", "Shared release planning", 20),
        owner: { actor: actor(other) },
      };
      // Prompt/mention evidence is Gateway-owned, not the bounded browser participant preview.
      const mentioned = {
        ...row("mentioned", "Design review mention", 10),
        owner: { actor: actor(other) },
      };
      const personal = [owned, prompted, mentioned];
      const team = Array.from({ length: 300 }, (_, i) => ({
        ...row("team-" + i, "Team conversation " + i, 1000 - i),
        owner: { actor: actor(other) },
      }));
      const hidden = {
        ...row("hidden", "Personally hidden conversation", 2000),
        hiddenFromInvolvingMe: true,
      };
      const broadPage = [hidden, ...team.slice(0, 299)];
      const gateway = await installMockGateway(page, {
        hasMultipleSessionSharingIdentities: true,
        presenceUsers: [
          { self: true, id: viewer, identity: { type: "profile", id: viewer }, name: viewer },
        ],
        sessions: [...team, ...personal, hidden],
        historyMessages: [],
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { involvingMe: true }, response: result(personal) },
              { response: { ...result(broadPage), hasMore: true, nextOffset: 300 } },
            ],
          },
        },
      });
      await page.goto(
        surface === "new"
          ? suite.server.baseUrl + "new"
          : controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"),
      );
      const names = page.locator(".agent-chat__recent-name");
      await expect.poll(() => names.count()).toBeGreaterThan(0);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && viewer === "alice") {
        const frame = await takeControlUiScreenshotFrame(page, names.first(), [names.first()], {
          animations: "disabled",
        });
        const destination = path.join(suite.artifactDir, surface + ".png");
        await writeFile(destination, frame.png);
        console.log("Welcome proof: " + destination);
      }
      await expect
        .poll(() => names.allTextContents())
        .toEqual([ownTitle, "Shared release planning", "Design review mention"]);
      const requests = await gateway.getRequests("sessions.list");
      expect(
        requests.some(({ params }) => params?.involvingMe === true && params.agentId === "main"),
      ).toBe(true);
      // The primary roster remains broad: personal rows lie beyond its first page.
      expect(requests.some(({ params }) => params?.involvingMe !== true)).toBe(true);
    },
  );
});
