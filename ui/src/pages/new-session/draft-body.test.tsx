import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { buildLocalUserMessage } from "../chat/user-message-content.ts";
import { NewSessionBody } from "./draft-body.solid.tsx";

it.each([
  { userId: "profile-alex", placement: "gutter" },
  { userId: null, placement: "footer" },
])("immediately shows the own-user avatar in the $placement", async ({ userId, placement }) => {
  const avatarUrl = "/api/users/profile-alex/avatar?v=1";
  const { container } = mountSolid(() => (
    <NewSessionBody
      error={null}
      pendingMessage={buildLocalUserMessage({
        createdAt: 1,
        text: "Hello from Alex",
        sender: {
          identity: { type: "profile", id: "profile-alex" },
          name: "Alex",
          profileAvatarUrl: avatarUrl,
        },
      })}
      userId={userId}
      submitting={true}
      renderDraft={() => null}
      onOpenImage={() => {}}
    />
  ));
  await waitForSolid(() => {
    const group = container.querySelector(".chat-group.user");
    const avatar = group?.querySelector(
      placement === "gutter"
        ? ":scope > .chat-avatar-slot img"
        : ":scope > .chat-group-footer > .chat-group-footer__meta .chat-author-avatar img",
    );
    expect(avatar?.getAttribute("src")).toBe(avatarUrl);
    expect(group?.classList.contains("chat-group--with-footer")).toBe(true);
    expect(group?.closest(".chat-thread--direct") !== null).toBe(placement === "footer");
  });
});

it("keeps the replacement draft locked and its recovery action available until submission settles", async () => {
  const [submitting, setSubmitting] = createSignal(true);
  const recover = vi.fn();
  const { container } = mountSolid(() => (
    <NewSessionBody
      error="Failed to create session"
      errorAction={{ label: "Recover draft", onClick: recover }}
      pendingMessage={null}
      submitting={submitting()}
      renderDraft={() => <textarea aria-label="Draft message" />}
      onOpenImage={() => {}}
    />
  ));
  const scroll = container.querySelector(".new-session-page__scroll");
  expect(scroll?.hasAttribute("inert")).toBe(true);
  expect(scroll?.getAttribute("aria-busy")).toBe("true");
  setSubmitting(false);
  await waitForSolid(() => {
    expect(scroll?.hasAttribute("inert")).toBe(false);
    expect(scroll?.getAttribute("aria-busy")).toBe("false");
  });
  container.querySelector<HTMLButtonElement>("[role=alert] button")?.click();
  expect(recover).toHaveBeenCalledOnce();
  expect(container.querySelector("textarea")).not.toBeNull();
});

it("replaces startup progress with an actionable completion while retaining the requested draft", async () => {
  const open = vi.fn();
  const [completion, setCompletion] = createSignal<{ label: string; onOpen: () => void }>();
  const { container } = mountSolid(() => (
    <NewSessionBody
      error={null}
      pendingMessage={buildLocalUserMessage({ createdAt: Date.now(), text: "Start working" })}
      submitting={true}
      completion={completion()}
      showDraft={true}
      renderDraft={() => <textarea aria-label="Next message" />}
      onOpenImage={() => {}}
    />
  ));
  expect(container.querySelector(".chat-working-indicator")).not.toBeNull();
  expect(container.querySelector("textarea")).not.toBeNull();
  setCompletion({ label: "Session ready", onOpen: open });
  await waitForSolid(() => {
    expect(container.querySelector(".chat-working-indicator")).toBeNull();
    expect(container.querySelector(".sr-only")?.textContent).toBe("Session ready");
  });
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === t("sessionsView.openSession"),
  );
  button?.click();
  expect(open).toHaveBeenCalledOnce();
  expect(container.querySelector("textarea")).not.toBeNull();
});
