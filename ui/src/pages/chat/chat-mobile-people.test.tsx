/* @vitest-environment jsdom */
import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  composerFixture,
  mention,
  people,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";
import { createChatMobilePeopleMentions } from "./chat-mobile-people-mentions.ts";
import { projectChatMobilePeople } from "./chat-mobile-people.ts";
import type {
  HumanMentionAccess,
  HumanMentionRead,
} from "./components/chat-composer-mention-menu-state.ts";
import { ChatMobilePeopleGrid } from "./components/chat-mobile-people-grid.tsx";
import {
  ChatMobilePeopleBody,
  type ChatMobilePeopleBodyProps,
} from "./components/chat-mobile-people.tsx";

afterEach(resetMentionComposerFixture);

const labels: ChatMobilePeopleBodyProps["labels"] = {
  people: "People",
  viewingNow: "Viewing now",
  creator: "Creator",
  owner: "Owner",
  participants: "Participants",
  mention: "Mention",
  mentionPerson: (name) => "Mention " + name,
  morePeople: (count) => count + " more people",
};

const human = (id: string, label: string) => ({
  type: "human" as const,
  id,
  label,
  identity: { type: "profile" as const, id },
});
const viewer = (
  value: Pick<ReturnType<typeof human>, "identity" | "label">,
  session = "agent:main:chat",
) => ({
  id: value.identity.id,
  identity: value.identity,
  name: value.label,
  watchedSessions: [session],
});

it("projects native identities and mentions through the People body without sending or closing on rejection", async () => {
  const composer = composerFixture("chat", "Review this");
  const access = composer.mentionAccess()!;
  const pending = createDeferred<UsersMentionableResult>();
  composer.request.mockReturnValueOnce(pending.promise);
  const mentions = createChatMobilePeopleMentions(composer.mentionAccess);
  const release = mentions.activate();
  onTestFinished(release);
  const shared = access.request();
  await vi.dynamicImportSettled();
  await vi.waitFor(() => expect(composer.request).toHaveBeenCalledTimes(1));
  pending.resolve(people);
  const read = await shared;
  await vi.advanceTimersByTimeAsync(0);
  expect(mentions.status).toBe("ready");
  expect(read?.result).toEqual(people);
  expect(mentions.read()?.result).toBe(read?.result);
  expect(access.read()?.result).toBe(read?.result);
  const owner = human("owner", "Avery Owner");
  const alex = {
    identity: { type: "profile" as const, id: "profile-alex-online" },
    label: "Alex Rivera",
  };
  const projection = () =>
    projectChatMobilePeople({
      session: {
        createdActor: owner,
        owner: { actor: owner },
        participants: [
          { identity: owner.identity, label: owner.label },
          alex,
          alex,
          {
            identity: {
              type: "remote",
              pluginId: "chat",
              domain: "team",
              idKind: "user",
              id: "profile-alex-online",
            },
            label: "Alex Remote",
          },
        ],
        participantCount: 6,
      },
      sessionKey: "agent:main:chat",
      viewers: [
        viewer(owner),
        viewer(alex),
        { id: "elsewhere", name: "Elsewhere", watchedSessions: ["agent:main:other"] },
      ],
      mentionableUsers: mentions.read()?.result.users ?? [],
    });
  const close = vi.fn();
  const open = vi.fn();
  const view = mountSolid(() => (
    <>
      <ChatMobilePeopleGrid
        people={projection()}
        label="Open people"
        morePeople={labels.morePeople}
        expanded={false}
        controls="people-page"
        onOpen={open}
      />
      <ChatMobilePeopleBody
        people={projection()}
        labels={labels}
        sharingOptions={<span>Sharing options</span>}
        onMention={(person) => {
          if (mentions.insert(person.profileId)) {
            close();
          }
        }}
      />
    </>
  ));
  expect(view.queryByRole("region", { name: "Creator" })).toBeNull();
  expect(view.getByRole("region", { name: "Owner" }).textContent).toContain("Avery");
  expect(view.getByRole("region", { name: "Participants" }).querySelectorAll("li")).toHaveLength(2);
  expect(view.getByText("3 more people")).toBeDefined();
  expect(view.getByRole("heading", { name: "Participants" }).textContent).toBe("Participants");
  expect(view.queryByText("Elsewhere")).toBeNull();
  const trigger = view.getByRole("button", { name: "Open people" });
  trigger.click();
  expect(open).toHaveBeenCalledExactlyOnceWith(trigger);
  const textarea = composer.container.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.setSelectionRange(7, 11);
  const participantMention = view
    .getByRole("region", { name: "Participants" })
    .querySelector<HTMLButtonElement>('button[aria-label="Mention Alex Rivera"]')!;
  expect(view.queryByRole("button", { name: "Mention Alex Remote" })).toBeNull();
  participantMention.click();
  composer.refresh();
  await vi.advanceTimersByTimeAsync(0);
  composer.expectValue("Review @Alex ", [mention("profile-alex-online", 7, 12)]);
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([13, 13]);
  expect(close).toHaveBeenCalledOnce();
  expect(composer.send).not.toHaveBeenCalled();
  composer.replaceOwner();
  expect(read?.insert("profile-alex-offline")).toBe(false);
  expect(access.read()).toBeNull();
  participantMention.click();
  expect(mentions.status).toBe("insert-rejected");
  expect(close).toHaveBeenCalledOnce();
  expect(composer.value().draft).toBe("Review @Alex ");
  release();
  flush();
  expect(mentions.read()).toBeNull();
  expect(mentions.status).toBe("idle");
});

it("ignores retired activation results and preserves explicit failure and retry outcomes", async () => {
  const old = createDeferred<HumanMentionRead | null>();
  const current = createDeferred<HumanMentionRead | null>();
  const receipt: HumanMentionRead = {
    result: { ...people, truncated: true },
    insert: vi.fn(() => false),
  };
  const first: HumanMentionAccess = { read: () => null, request: () => old.promise };
  const request = vi.fn<HumanMentionAccess["request"]>().mockReturnValueOnce(current.promise);
  let access: HumanMentionAccess | undefined = first;
  const mentions = createChatMobilePeopleMentions(() => access);
  const releaseOld = mentions.activate();
  releaseOld();
  access = { read: () => receipt, request };
  const releaseCurrent = mentions.activate();
  onTestFinished(releaseCurrent);
  releaseOld();
  old.resolve({ ...receipt, result: { users: [], truncated: false } });
  await old.promise;
  await Promise.resolve();
  expect(mentions.status).toBe("loading");
  current.resolve(receipt);
  await current.promise;
  await Promise.resolve();
  expect(mentions.status).toBe("ready");
  expect(mentions.truncated).toBe(true);
  expect(mentions.insert("missing")).toBe(false);
  expect(mentions.status).toBe("insert-rejected");
  request.mockRejectedValueOnce(new Error("Lookup failed"));
  await mentions.request("retry");
  expect(mentions.status).toBe("error");
  expect(mentions.error).toBe("Lookup failed");
  request.mockResolvedValueOnce(receipt);
  await mentions.request();
  expect(mentions.status).toBe("ready");
  access = undefined;
  expect(mentions.status).toBe("unavailable");
  expect(mentions.read()).toBeNull();
});

it("shows only concurrent viewers in the header, never a lone creator or visitor", () => {
  const creator = human("creator", "Creator");
  const viewers = [viewer(creator, "chat"), viewer(human("guest", "Guest"), "chat")];
  const project = (active: typeof viewers) =>
    projectChatMobilePeople({
      session: { createdActor: creator, owner: { actor: creator } },
      sessionKey: "chat",
      viewers: active,
      mentionableUsers: [],
    });
  expect(project([]).header).toEqual([]);
  expect(project([viewers[0]!]).header).toEqual([]);
  expect(project([viewers[1]!]).header).toEqual([]);
  expect(project([viewers[0]!, viewers[0]!]).header).toEqual([]);
  expect(project(viewers).header.map((person) => person.label)).toEqual(["Creator", "Guest"]);
  expect(project([viewers[1]!, { ...viewers[0]!, watchedSessions: ["elsewhere"] }]).header).toEqual(
    [],
  );
});
