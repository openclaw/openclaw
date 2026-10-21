/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  composerFixture,
  people,
  resetMentionComposerFixture,
} from "./chat-composer-mentions.test-support.ts";
import { createChatMobilePeopleMentions } from "./chat-mobile-people-mentions.ts";
import { projectChatMobilePeople } from "./chat-mobile-people.ts";
import type {
  HumanMentionAccess,
  HumanMentionRead,
} from "./components/chat-composer-mention-menu.tsx";
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

it("projects native identities and mentions through the People body without sending or closing on rejection", async () => {
  const composer = composerFixture("chat", "Review this");
  const mentions = createChatMobilePeopleMentions(composer.mentionAccess);
  const release = mentions.activate();
  onTestFinished(release);
  await vi.advanceTimersByTimeAsync(0);
  expect(mentions.status).toBe("ready");
  expect(composer.request).toHaveBeenCalledTimes(1);
  const owner = {
    type: "human" as const,
    id: "owner",
    label: "Avery Owner",
    identity: { type: "profile" as const, id: "owner" },
  };
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
        {
          id: "profile-alex-online",
          identity: alex.identity,
          name: alex.label,
          watchedSessions: ["agent:main:chat"],
        },
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
  expect(composer.value()).toEqual({
    draft: "Review @Alex ",
    mentions: [{ profileId: "profile-alex-online", start: 7, end: 12 }],
  });
  expect(close).toHaveBeenCalledOnce();
  expect(composer.send).not.toHaveBeenCalled();
  composer.replaceOwner();
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
