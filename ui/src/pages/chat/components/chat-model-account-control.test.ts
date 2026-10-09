import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { UsersListModelAccountsResult } from "../../../../../packages/gateway-protocol/src/index.ts";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ModelAuthStatusResult } from "../../../api/types.ts";
import { renderChatModelAccountControl } from "./chat-model-account-control.ts";

afterEach(() => document.body.replaceChildren());

function status(): ModelAuthStatusResult {
  return {
    ts: 1,
    providers: [
      {
        provider: "openai-codex",
        displayName: "OpenAI",
        status: "ok",
        profiles: [
          { profileId: "openai:primary", type: "oauth", status: "ok", displayName: "Workspace" },
          {
            profileId: "openai:alternate",
            type: "oauth",
            status: "expired",
            displayName: "Workspace",
          },
          { profileId: "openai:alternate", type: "oauth", status: "ok", displayName: "Workspace" },
          {
            profileId: "openai:inactive",
            type: "oauth",
            status: "missing",
            reasonCode: "setup_inactive",
          },
        ],
      },
    ],
  };
}

function mount(
  inventory: UsersListModelAccountsResult = { profileId: "test-person", accounts: [], links: [] },
) {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
  const request = vi.spyOn(client, "request").mockResolvedValue(inventory);
  let current = true;
  const params: Parameters<typeof renderChatModelAccountControl>[0] = {
    modelAuthStatusResult: status(),
    owner: {},
    client,
    model: "openai/shared-alpha",
    disabled: false,
    selection: { kind: "shared", authProfileId: "openai:primary", label: "Workspace" },
    ownsSelection: () => current,
    onSelect: vi.fn().mockResolvedValue(true),
    onRequestUpdate: () => update(),
  };
  function update(patch: Partial<typeof params> = {}) {
    Object.assign(params, patch);
    const section = renderChatModelAccountControl(params);
    if (!section) {
      throw new Error("Expected an account selection section");
    }
    render(section.render(0), container);
  }
  update();
  const option = (value: string) =>
    container.querySelector<HTMLButtonElement>(`[data-chat-account-option="${value}"]`);
  const open = async () => {
    container.querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")!.click();
    await request.mock.results[0]?.value.catch(() => undefined);
  };
  return {
    container,
    params,
    request,
    open,
    update,
    option,
    retire: () => {
      current = false;
    },
  };
}

it("deduplicates provider aliases and retains refreshable credentials while excluding inactive setup accounts", async () => {
  const p = mount({
    profileId: "test-person",
    links: [],
    accounts: [
      {
        authProfileId: "openai:alternate",
        provider: "codex",
        label: "Personal label",
        authType: "oauth",
        selected: false,
      },
      {
        authProfileId: "anthropic:other",
        provider: "anthropic",
        label: "Other provider",
        authType: "oauth",
        selected: false,
      },
    ],
  });
  await p.open();
  expect(p.container.querySelectorAll('[data-chat-account-option="current"]')).toHaveLength(1);
  expect(
    p.container.querySelectorAll('[data-chat-account-option="account:openai:alternate"]'),
  ).toHaveLength(1);
  expect(p.option("account:openai:alternate")?.textContent).toContain("Personal label");
  expect(p.option("account:openai:inactive")).toBeNull();
  expect(p.option("account:anthropic:other")).toBeNull();
  p.option("account:openai:alternate")!.click();
  expect(p.params.onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ authProfileId: "openai:alternate" }),
  );
});

it("keeps shared account choices usable when personal inventory fails", async () => {
  const p = mount();
  p.request.mockRejectedValue(new Error("Personal inventory is unavailable"));
  await p.open();
  expect(p.container.querySelector('[role="alert"]')?.textContent).toContain(
    "Personal inventory is unavailable",
  );
  const alternate = p.option("account:openai:alternate");
  expect(alternate?.disabled).toBe(false);
  alternate!.click();
  expect(p.params.onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ authProfileId: "openai:alternate" }),
  );
});

it("rejects stale shared-choice clicks after auth publication and honors read-only and retired selections", async () => {
  const p = mount();
  await p.open();
  const stale = p.option("account:openai:alternate")!;
  expect(stale).not.toBeNull();
  p.update({ modelAuthStatusResult: { ts: 2, providers: [] } });
  expect(p.option("account:openai:alternate")).toBeNull();
  stale.click();
  expect(p.params.onSelect).not.toHaveBeenCalled();
  p.update({ modelAuthStatusResult: status(), disabled: true });
  p.option("account:openai:alternate")!.click();
  expect(p.params.onSelect).not.toHaveBeenCalled();
  p.update({ disabled: false });
  p.retire();
  p.option("account:openai:alternate")!.click();
  expect(p.params.onSelect).not.toHaveBeenCalled();
});

it("keeps distinct credential realms separate even when their usage is grouped", async () => {
  const p = mount({
    profileId: "test-person",
    links: [],
    accounts: [
      {
        authProfileId: "personal:portal",
        provider: "minimax-portal",
        label: "Portal",
        authType: "oauth",
        selected: false,
      },
    ],
  });
  p.update({
    model: "minimax/model",
    selection: { kind: "shared", authProfileId: "minimax:primary", label: "Primary" },
    modelAuthStatusResult: {
      ts: 1,
      providers: [
        {
          provider: "minimax",
          displayName: "MiniMax",
          status: "ok",
          profiles: [{ profileId: "minimax:primary", type: "api_key", status: "ok" }],
        },
        {
          provider: "minimax-portal",
          displayName: "MiniMax Portal",
          status: "ok",
          profiles: [{ profileId: "minimax:portal", type: "oauth", status: "ok" }],
        },
      ],
    },
  });
  await p.open();
  expect(p.option("account:minimax:portal")).toBeNull();
  expect(p.option("account:personal:portal")).toBeNull();
});
