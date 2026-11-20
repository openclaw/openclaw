import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Participate" });
const key = "agent:main:dashboard:619dfdde-5f1b-4f7f-be9c-68ab72f812f8";
const methods = [
  ...defaultControlUiFeatureMethods,
  "session.members.setAccess",
  "users.mentionable",
  "session.suggestions.add",
  "session.suggestions.list",
];
const creator = {
  id: "morgan",
  type: "human",
  label: "Morgan",
  identity: { type: "profile", id: "morgan" },
} as const;
const participant = {
  id: "alice",
  type: "human",
  label: "Alice",
  identity: { type: "profile", id: "alice" },
} as const;
const viewport = { width: 1280, height: 820 };
let artifacts: string;
async function capture(page: Page, name: string) {
  artifacts ??= createControlUiE2eArtifactDir("flows", path.resolve(".artifacts/participate-ui"));
  const surface = page.locator(".agent-chat__composer-shell").filter({ visible: true }).first();
  const frame = await takeControlUiScreenshotFrame(page, surface, [], { animations: "disabled" });
  await writeFile(path.join(artifacts, `${name}.png`), frame.png);
}

suite.define(() => {
  it.each(["ceiling", "ordinary", "unadvertised"] as const)(
    "invites %s mentions without changing ordinary flows",
    async (kind) => {
      await suite.withPage({ viewport, colorScheme: "dark" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          sessions: [
            createControlUiSessionRow(key, "Launch planning", Date.now(), {
              sharingRole: "owner",
              visibility: "shared",
              createdActor: creator,
            }),
          ],
          featureMethods:
            kind === "unadvertised"
              ? methods.filter((method) => method !== "session.members.setAccess")
              : methods,
          presenceUsers: [
            {
              self: true,
              id: "morgan",
              name: "Morgan",
              identity: { type: "profile", id: "morgan" },
            },
          ],
          methodResponses: {
            "users.mentionable": {
              users: [
                {
                  profileId: "alice",
                  displayName: "Alice",
                  online: true,
                  ...(kind === "ordinary" ? {} : { inviteAccessOptions: ["read", "suggest"] }),
                },
              ],
              truncated: false,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const input = page.locator(".agent-chat__composer-combobox textarea");
        await input.fill("Review @Ali");
        await page.getByRole("listbox", { name: "Mention a person" }).getByRole("option").click();
        if (kind === "ceiling") {
          const bar = page.locator(".chat-invite-access");
          await bar.waitFor();
          expect(await bar.textContent()).toContain("Invite Alice to this session asCan read");
          await bar.getByRole("button", { name: "Invitation level for Alice" }).click();
          expect(
            await page.getByRole("menuitemradio", { name: "Can send", exact: true }).count(),
          ).toBe(0);
          await capture(page, "invite-levels");
          await page.getByRole("menuitemradio", { name: "Can suggest", exact: true }).click();
          await expect.poll(() => bar.textContent()).toContain("Can suggest");
          await page
            .getByRole("menuitemradio", { name: "Can suggest", exact: true })
            .waitFor({ state: "hidden" });
        } else {
          expect(await page.locator(".chat-invite-access").count()).toBe(0);
          await capture(page, kind);
        }
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          mentions: [
            {
              profileId: "alice",
              start: 7,
              end: 13,
              ...(kind === "ceiling" ? { access: "suggest" } : {}),
            },
          ],
        });
        if (kind !== "ceiling") {
          expect(JSON.stringify(sent.params)).not.toContain('"access"');
        }
      });
    },
  );

  it.each(["send", "suggest", "read"] as const)(
    "presents the invited %s composer without operator.write",
    async (access) => {
      await suite.withPage({ viewport, colorScheme: "dark" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          featureMethods: methods,
          operatorScopes: ["operator.sessions.read"],
          operatorSessionCap: "invited",
          roleAllowsAdmin: false,
          sessions: [
            createControlUiSessionRow(key, "Launch planning", Date.now(), {
              sharingRole: access === "send" ? "member" : "viewer",
              invitedAccess: access,
              visibility: "shared",
              createdActor: creator,
              permissionMode: "workspace",
            }),
          ],
          presenceUsers: [
            { self: true, id: "alice", name: "Alice", identity: { type: "profile", id: "alice" } },
          ],
          methodResponses: {
            "session.suggestions.list": { sessionKey: key, role: "viewer", suggestions: [] },
            "session.suggestions.add": {
              suggestion: {
                id: "suggestion-1",
                agentId: "main",
                sessionKey: key,
                text: "Review the launch plan",
                author: { id: "alice", label: "Alice", type: "human" },
                createdAt: Date.now(),
                status: "pending",
              },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const input = page.locator(".agent-chat__composer-combobox textarea");
        await input.waitFor({ state: "attached" });
        if (access === "read") {
          expect(await input.isDisabled()).toBe(true);
          await capture(page, "read-only-participant");
          return;
        }
        await expect.poll(() => input.isDisabled()).toBe(false);
        if (access === "send") {
          const picker = page.locator("[data-chat-permission-select]");
          await expect.poll(() => picker.textContent()).toContain("Ask me · set by Morgan");
          await picker.click();
          expect(
            await page
              .locator("[data-chat-permission-option]")
              .evaluateAll((items) =>
                items.map((item) => item.getAttribute("data-chat-permission-option")),
              ),
          ).toEqual(["read-only", "guarded"]);
          await capture(page, "participant-permissions");
          await page.keyboard.press("Escape");
        }
        await input.fill("Review the launch plan");
        await capture(page, `${access}-participant`);
        await input.press("Enter");
        const sent = await gateway.waitForRequest(
          access === "send" ? "chat.send" : "session.suggestions.add",
        );
        expect(sent.params).toMatchObject(
          access === "send"
            ? { message: "Review the launch plan" }
            : { text: "Review the launch plan" },
        );
        expect(
          await gateway.getRequests(access === "send" ? "session.suggestions.add" : "chat.send"),
        ).toHaveLength(0);
      });
    },
  );

  it("changes a ceiling member’s level from shared session permissions", async () => {
    await suite.withPage({ viewport, colorScheme: "dark" }, async ({ page }) => {
      const evidence = {
        sessionKey: key,
        owner: creator,
        members: [{ identityId: "alice", addedBy: "morgan", addedAt: 1, access: "send" }],
        identities: [creator, participant],
        permissions: [
          {
            identityId: "alice",
            level: "send",
            options: ["read", "suggest", "send"],
            invitation: "member",
          },
        ],
        role: "owner",
        allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
      };
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        featureMethods: methods,
        sessions: [
          createControlUiSessionRow(key, "Launch planning", Date.now(), {
            sharingRole: "owner",
            visibility: "shared",
            createdActor: creator,
          }),
        ],
        methodResponses: {
          "session.members.listEvidence": evidence,
          "session.members.setAccess": { ok: true, sessionKey: key, identityId: "alice" },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page.locator(".chat-pane__sharing-trigger").filter({ visible: true }).click();
      const surface = page.locator(".chat-pane__sharing-panel");
      await surface.getByText("Alice", { exact: true }).waitFor();
      await surface.getByRole("menuitem", { name: "Alice, Can send", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Can suggest", exact: true }).waitFor();
      expect(await surface.textContent()).toContain(
        "Lowering access cancels Alice’s queued messages",
      );
      await capture(page, "sharing-levels");
      await page.getByRole("menuitemradio", { name: "Can suggest", exact: true }).click();
      expect((await gateway.waitForRequest("session.members.setAccess")).params).toMatchObject({
        sessionKey: key,
        identityId: "alice",
        access: "suggest",
      });
      expect(await gateway.getRequests("session.members.remove")).toHaveLength(0);
    });
  });
  it("shows participants status without reviewer payload and clears it on terminal", async () => {
    await suite.withPage({ viewport, colorScheme: "dark" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        featureMethods: methods,
        operatorScopes: ["operator.sessions.read"],
        operatorSessionCap: "invited",
        roleAllowsAdmin: false,
        sessions: [
          createControlUiSessionRow(key, "Launch planning", Date.now(), {
            sharingRole: "member",
            invitedAccess: "send",
            visibility: "shared",
            createdActor: creator,
          }),
        ],
        presenceUsers: [
          { self: true, id: "alice", name: "Alice", identity: { type: "profile", id: "alice" } },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page.locator(".agent-chat__composer-combobox textarea").fill("Review pending approval");
      const event = {
        phase: "participant",
        sessionKey: key,
        approvalId: "approval-1",
        runId: "run-1",
        participantId: "alice",
        status: "pending",
        updatedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      };
      await gateway.emitGatewayEvent("session.approval", {
        ...event,
        participantId: "someone-else",
      });
      expect(
        await page
          .getByText("Your turn is waiting for the session creator’s approval.", { exact: true })
          .count(),
      ).toBe(0);
      await gateway.emitGatewayEvent("session.approval", event);
      const notice = page.getByText("Your turn is waiting for the session creator’s approval.", {
        exact: true,
      });
      await notice.waitFor();
      expect(await page.locator("[data-approval-id]").count()).toBe(0);
      await capture(page, "participant-waiting");
      await gateway.emitGatewayEvent("session.approval", {
        ...event,
        status: "terminal",
        updatedAtMs: Date.now(),
      });
      await notice.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("exec.approval.resolve")).toHaveLength(0);
    });
  });

  it("attributes a creator’s approval card to the participant turn", async () => {
    await suite.withPage({ viewport, colorScheme: "dark" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        featureMethods: methods,
        sessions: [
          createControlUiSessionRow(key, "Launch planning", Date.now(), {
            sharingRole: "owner",
            visibility: "shared",
            createdActor: creator,
          }),
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      await gateway.emitGatewayEvent("exec.approval.requested", {
        id: "participant-command",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        request: {
          command: "pnpm test",
          agentId: "main",
          sessionKey: key,
          turnActor: { id: "alice", label: "Alice" },
        },
      });
      const card = page.locator('.chat-inline-approval [data-approval-id="participant-command"]');
      await card.getByText("Requested during Alice’s turn", { exact: true }).waitFor();
      await capture(page, "creator-approval");
    });
  });
  it("renders invitation and access-change notices without changing stored history", async () => {
    await suite.withPage({ viewport, colorScheme: "dark" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        featureMethods: methods,
        sessions: [
          createControlUiSessionRow(key, "Launch planning", Date.now(), {
            sharingRole: "owner",
            visibility: "shared",
            createdActor: creator,
          }),
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      const event = {
        action: "member-added",
        sessionKey: key,
        agentId: "main",
        identityId: "Alice",
        ts: Date.now(),
        actor: creator,
      };
      await gateway.emitGatewayEvent("session.sharing", event);
      expect(
        await page.getByText("Morgan invited Alice with Read access", { exact: true }).count(),
      ).toBe(0);
      await gateway.emitGatewayEvent("session.sharing", { ...event, access: "read" });
      await page.getByText("Morgan invited Alice with Read access", { exact: true }).waitFor();
      await gateway.emitGatewayEvent("session.sharing", {
        ...event,
        ts: Date.now() + 1,
        action: "member-access-changed",
        access: "send",
      });
      await page.getByText("Morgan changed Alice’s access to Send", { exact: true }).waitFor();
      await capture(page, "transcript-notices");
    });
  });

  it("describes ceiling roles on the Access page without changing ordinary roles", async () => {
    await suite.withPage({ viewport, colorScheme: "dark" }, async ({ page }) => {
      const gateway = await installNativePluginMockGateway(page, {
        nativePlugins: [
          {
            pluginId: "openclaw-id-access",
            rootDir: path.resolve("extensions/openclaw-id-access"),
            source: "./browser/index.tsx",
          },
        ],
        methodResponses: {
          "openclawId.status": {
            status: { state: "on" },
            owner: true,
            channel: "local_operator",
            link: { linked: true },
          },
          "openclawId.people": { link: { linked: true } },
        },
      });
      await page.goto(suite.server.baseUrl + "plugin?plugin=openclaw-id-access&id=access");
      await page.locator(".ocid-access").waitFor();
      // A fresh fixture key establishes this browser's owner-device readiness only.
      const devicePub = await page.evaluate(async () => {
        const pair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
        const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open("openclaw-id", 1);
          open.addEventListener("upgradeneeded", () =>
            open.result.createObjectStore("owner-devices"),
          );
          open.addEventListener("error", () =>
            reject(open.error ?? new Error("Could not open fixture key store")),
          );
          open.addEventListener("success", () => {
            const db = open.result;
            const tx = db.transaction("owner-devices", "readwrite");
            tx.objectStore("owner-devices").put(pair, "synthetic-claw");
            tx.addEventListener("complete", () => {
              db.close();
              resolve();
            });
            tx.addEventListener("error", () => {
              db.close();
              reject(tx.error ?? new Error("Could not store fixture key"));
            });
          });
        });
        return (
          "ed25519:" + Array.from(raw, (value) => value.toString(16).padStart(2, "0")).join("")
        );
      });
      const link = {
        linked: true,
        clawId: "synthetic-claw",
        ownerDevices: [{ devicePub, label: "Synthetic browser", peerKeys: [], cert: {} }],
        roles: [
          {
            name: "operator",
            defined: true,
            sessions: "write",
            requiresSandbox: false,
            admin: false,
          },
          {
            name: "participant",
            defined: true,
            sessions: "invited",
            maxInvitedAccess: "send",
            requiresSandbox: false,
            admin: false,
          },
        ],
        members: [],
        invites: [],
        nodes: [],
      };
      await gateway.setMethodResponse("openclawId.people", { link });
      await gateway.emitGatewayEvent("openclawId.people.changed");
      const invite = page.locator('[aria-labelledby="ocid-access-invite"]');
      await invite.locator(".ocid-access__role-picker button").click();
      const option = page.getByRole("option", { name: /^participant/ });
      await option.waitFor();
      expect(await option.textContent()).toContain(
        "Only sessions they’re invited to · Can be invited up to Send",
      );
      expect(await page.getByRole("option", { name: /^Operator/ }).textContent()).not.toContain(
        "Can be invited up to",
      );
      artifacts ??= createControlUiE2eArtifactDir(
        "flows",
        path.resolve(".artifacts/participate-ui"),
      );
      const frame = await takeControlUiScreenshotFrame(page, invite, [option], {
        animations: "disabled",
      });
      await writeFile(path.join(artifacts, "access-role.png"), frame.png);
      expect(await gateway.getRequests("openclawId.authority")).toHaveLength(0);
    });
  });
});
