import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { mountSessionsRoute } from "./sessions-route.test-support.tsx";

it("submits the entire trimmed transcript query and keeps an over-limit draft editable", async () => {
  const search = vi.fn((_params: unknown) => ({
    results: [
      {
        sessionKey: "agent:main:cedar",
        sessionId: "cedar",
        messageId: "harvest",
        role: "user",
        snippet: "Cedar pear harvest",
        score: 1,
        timestamp: 1,
      },
    ],
    sessions: [],
  }));
  await mountSessionsRoute((method, params) =>
    method === "sessions.search" ? search(params) : sessionsResult([]),
  );

  const form = page.getByRole("search", { name: "Search chats" });
  const submit = form.getByRole("button", { name: "Search chats" });
  await submit.click();
  const input = form.getByRole("searchbox");
  // The sprout takes two UTF-16 units. Leading whitespace only counts in the draft.
  const query = "🌱".padEnd(4092, " ") + "pear";
  const draft = ` ${query}`;
  await input.fill(draft);
  await userEvent.keyboard("{Enter}");
  expect(search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ query }));
  await expect.element(input).toHaveValue(draft);
  const hit = page.getByRole("button", { name: /Cedar pear harvest/ });
  await expect.element(hit).toBeVisible();

  const overflow = query + "s";
  await input.fill(overflow);
  await submit.click();
  await expect.element(input).toHaveValue(overflow);
  await expect.element(input).toHaveAttribute("aria-invalid", "true");
  await expect.element(input).toHaveAccessibleDescription("4097 / 4096");
  await expect.element(hit).not.toBeInTheDocument();
  expect(search).toHaveBeenCalledTimes(1);

  await input.fill("   ");
  await userEvent.keyboard("{Enter}");
  expect(search).toHaveBeenCalledTimes(1);
  await input.fill("  pear ");
  await submit.click();
  expect(search).toHaveBeenCalledTimes(2);
  expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: "pear" }));
  await expect.element(hit).toBeVisible();
});
