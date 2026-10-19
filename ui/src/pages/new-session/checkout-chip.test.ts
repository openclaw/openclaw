import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resolveCheckoutChip, type CheckoutChipOptions } from "./checkout-chip.ts";
import { CheckoutChip } from "./checkout-chip.tsx";

function checkoutOptions(overrides: Partial<CheckoutChipOptions> = {}): CheckoutChipOptions {
  return {
    state: { label: "New worktree from main" },
    remotePlacement: false,
    folderLabel: "OpenClaw",
    worktree: true,
    worktreeAvailable: true,
    branches: {
      repoRoot: "/repo",
      branches: [{ name: "main", kind: "local" }],
      headBranch: "main",
    },
    branchesLoading: false,
    baseRef: "main",
    worktreeName: "",
    submitting: false,
    pendingPlacement: false,
    popoverOpen: true,
    onPopoverShow: vi.fn(),
    onPopoverHide: vi.fn(),
    onPopoverAfterHide: vi.fn(),
    onSelectWorktree: vi.fn(),
    onBaseRefInput: vi.fn(),
    onWorktreeNameInput: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

const popoverSelector = ".new-session-page__checkout-popover";
const afterHide = (container: HTMLElement) =>
  container.querySelector(popoverSelector)!.dispatchEvent(new CustomEvent("overlay-after-hide"));
const expectOpen = (container: HTMLElement) =>
  waitForSolid(() =>
    expect(container.querySelector(popoverSelector)?.getAttribute("data-phase")).toBe("open"),
  );
const keydown = (element: Element, key: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

function mountCheckout(initial: CheckoutChipOptions) {
  const [params, setParams] = createSignal(initial);
  const mounted = mountSolid(() =>
    createComponent(CheckoutChip, {
      get params() {
        return params();
      },
    }),
  );
  return {
    container: mounted.container,
    query: <T extends Element = HTMLElement>(selector: string): T | null =>
      mounted.container.querySelector<T>(selector),
    update: (next: CheckoutChipOptions) => {
      setParams(next);
      flush();
    },
  };
}

describe("Checkout chip state", () => {
  type LabelInput = Partial<Parameters<typeof resolveCheckoutChip>[0]>;
  const expectLabel = (input: LabelInput, label: string) =>
    expect(
      resolveCheckoutChip({
        destination: "local",
        worktree: true,
        baseRef: "main",
        worktreeName: "",
        ...input,
      }),
    ).toEqual({ label });

  it.each([
    [{ destination: "cloud", repository: false }, "From main"],
    [{ destination: "cloud", repository: true, worktree: false, baseRef: "" }, "Starting branch"],
    [
      { destination: "remote", repository: true, worktree: false, baseRef: "release" },
      "Remote checkout from release",
    ],
    [{ destination: "remote", repository: true, worktree: false, baseRef: "" }, "Remote checkout"],
    [{ worktree: false, headBranch: "feature" }, "feature"],
    [{ worktree: false }, "Current checkout"],
    [{ headBranch: "feature" }, "New worktree from main"],
    [{ baseRef: "" }, "New worktree"],
  ] satisfies [LabelInput, string][])("labels checkout %j as %s", expectLabel);

  it.each([
    [{ worktreeName: " release-proof " }, "Worktree · release-proof"],
    [{ worktreeName: "   " }, "New worktree from main"],
    [{ worktree: false, worktreeName: "release-proof" }, "main"],
    [{ destination: "cloud", repository: true, worktreeName: "release-proof" }, "From main"],
  ] satisfies [LabelInput, string][])("labels named checkout %j as %s", (input, label) =>
    expectLabel({ headBranch: "main", ...input }, label),
  );

  it.each([
    { worktree: false, remotePlacement: false, repository: false },
    { worktree: true, remotePlacement: false, repository: false },
    {
      worktree: true,
      remotePlacement: false,
      repository: false,
      currentCheckoutUnavailableReason: "Use an isolated worktree for this project and agent",
    },
    { worktree: true, remotePlacement: true, repository: false },
    { worktree: false, remotePlacement: true, repository: true },
    { worktree: false, remotePlacement: true, repository: true, emptyBranches: true },
  ])(
    "offers explicit checkout choices (worktree=$worktree, remote=$remotePlacement, emptyBranches=$emptyBranches)",
    async ({
      worktree,
      remotePlacement,
      repository,
      emptyBranches,
      currentCheckoutUnavailableReason,
    }) => {
      const params = checkoutOptions({
        state: { label: worktree ? "New worktree from main" : "feature" },
        remotePlacement,
        currentCheckoutUnavailableReason,
        repository,
        worktree,
        branches: {
          repoRoot: "/repo",
          branches: emptyBranches
            ? []
            : [
                { name: "main", kind: "local" },
                { name: "release/next", kind: "local" },
              ],
          headBranch: "feature",
        },
      });
      const { onSelectWorktree, onBaseRefInput, onWorktreeNameInput, onConfirm } =
        vi.mocked(params);
      const { container, query } = mountCheckout(params);

      await expectOpen(container);

      if (worktree || repository) {
        const baseRef = query("input")!;
        if (emptyBranches) {
          expect(baseRef.hasAttribute("role")).toBe(false);
          expect(baseRef.hasAttribute("aria-expanded")).toBe(false);
          expect(query('[role="listbox"]')).toBeNull();
        } else {
          expect(baseRef.getAttribute("role")).toBe("combobox");
          expect(query('[role="listbox"]')?.getAttribute("aria-label")).toBe("From");
        }
      }

      if (repository) {
        expect(query('[data-value="checkout"]')).toBeNull();
        expect(query('[data-value="worktree"]')).toBeNull();
        const inputs = container.querySelectorAll<HTMLInputElement>("input");
        expect(inputs).toHaveLength(1);
        inputs[0]!.value = "release/next";
        inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onBaseRefInput).toHaveBeenCalledWith("release/next");
        keydown(inputs[0]!, "Enter");
        afterHide(container);
        expect(onConfirm).toHaveBeenCalledOnce();
        expect(container.textContent).toContain(
          "Clones OpenClaw on the selected runner. No Gateway checkout is created.",
        );
        return;
      }

      const current = query<HTMLButtonElement>('[data-value="checkout"]')!;
      const isolated = query<HTMLButtonElement>('[data-value="worktree"]')!;
      expect(current.textContent).toContain("Current checkout");
      expect(current.querySelector(".session-menu__sub")?.textContent).toBe("feature");
      expect(current.querySelector(".session-menu__description")?.textContent).toBe(
        currentCheckoutUnavailableReason,
      );
      expect(current.getAttribute("aria-pressed")).toBe(String(!worktree));
      expect(current.disabled).toBe(remotePlacement || Boolean(currentCheckoutUnavailableReason));
      expect(current.getAttribute("title")).toBe(
        remotePlacement
          ? "Devices and cloud run in a worktree"
          : (currentCheckoutUnavailableReason ?? null),
      );
      expect(isolated.textContent).toContain("New worktree");
      expect(isolated.textContent).toContain("Isolated copy of the repo");
      expect(isolated.getAttribute("aria-pressed")).toBe(String(worktree));
      expect(isolated.disabled).toBe(false);
      expect(isolated.hasAttribute("title")).toBe(false);
      expect(current.hasAttribute("data-popover")).toBe(false);
      expect(isolated.hasAttribute("data-popover")).toBe(false);
      current.click();
      isolated.click();
      expect(onSelectWorktree.mock.calls).toEqual(
        remotePlacement || currentCheckoutUnavailableReason ? [[true]] : [[false], [true]],
      );

      const fields = container.querySelectorAll<HTMLLabelElement>(".new-session-page__menu-field");
      expect(fields).toHaveLength(worktree ? 2 : 0);
      if (worktree) {
        expect(fields[0]?.querySelector("span")?.textContent).toBe("From");
        expect(fields[1]?.querySelector("span")?.textContent).toBe("Name");
        const baseRef = fields[0]!.querySelector("input")!;
        const name = fields[1]!.querySelector("input")!;
        expect(baseRef.value).toBe("main");
        expect(name.placeholder).toBe("Named from the session title");
        baseRef.value = " release ";
        baseRef.dispatchEvent(new Event("input", { bubbles: true }));
        name.value = " checkout-proof ";
        name.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onBaseRefInput).toHaveBeenCalledWith(" release ");
        expect(onWorktreeNameInput).toHaveBeenCalledWith(" checkout-proof ");
        const suggestions = container.querySelectorAll("[data-worktree-suggestion]");
        expect([...suggestions].map((item) => item.textContent?.trim())).toEqual([
          "main",
          "release/next",
        ]);
        keydown(baseRef, "ArrowDown");
        keydown(baseRef, "ArrowDown");
        expect(baseRef.getAttribute("aria-activedescendant")).toBe(
          "new-session-worktree-branch-suggestion-1",
        );
        expect(suggestions[1]!.getAttribute("aria-selected")).toBe("true");
        for (const key of ["ArrowDown", "ArrowUp"]) {
          const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
          name.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(false);
          expect(name.hasAttribute("aria-activedescendant")).toBe(false);
          expect(suggestions[1]!.getAttribute("aria-selected")).toBe("true");
        }
        keydown(baseRef, "Enter");
        expect(onBaseRefInput).toHaveBeenLastCalledWith("release/next");
        expect(onConfirm).not.toHaveBeenCalled();
        (suggestions[1] as HTMLButtonElement).click();
        expect(onBaseRefInput).toHaveBeenLastCalledWith("release/next");
        keydown(name, "Enter");
        afterHide(container);
        expect(onConfirm).toHaveBeenCalledOnce();
        query<HTMLButtonElement>("#new-session-checkout-trigger")!.click();
        await expectOpen(container);
        keydown(baseRef, "ArrowDown");
        const branchWrites = onBaseRefInput.mock.calls.length;
        name.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }),
        );
        afterHide(container);
        expect(onBaseRefInput).toHaveBeenCalledTimes(branchWrites);
        expect(onConfirm).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain(
          "Creates a branch from the session title in a separate checkout.",
        );
      } else {
        expect(query(".new-session-page__menu-note")).toBeNull();
      }
      expect(container.textContent?.includes("Syncs OpenClaw to the selected runner")).toBe(
        remotePlacement,
      );
    },
  );

  it("keeps suggestion identities current and only confirms valid input", async () => {
    const params = checkoutOptions({ worktreeName: "picker-fixes" });
    const { onConfirm, onPopoverShow, onPopoverHide, onPopoverAfterHide } = vi.mocked(params);
    const { container, query, update } = mountCheckout(params);
    const renderNamed = (worktreeName: string) => update({ ...params, worktreeName });
    await expectOpen(container);
    onPopoverShow.mockClear();

    const trigger = query<HTMLButtonElement>("#new-session-checkout-trigger")!;
    expect(trigger.getAttribute("aria-controls")).toBe("new-session-checkout-popover");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.click();
    flush();
    expect(onPopoverHide).toHaveBeenCalledOnce();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    flush();
    await expectOpen(container);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(onPopoverShow).toHaveBeenCalledOnce();
    expect(onPopoverAfterHide).not.toHaveBeenCalled();
    onPopoverShow.mockClear();
    onPopoverHide.mockClear();

    expect(container.textContent).toContain(
      "Creates branch openclaw/picker-fixes in a separate checkout.",
    );
    const suggestionPopup = query(".new-session-page__branch-popup")!;
    for (const type of ["overlay-show", "overlay-hide", "overlay-after-hide"]) {
      suggestionPopup.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
    }
    expect(onPopoverShow).not.toHaveBeenCalled();
    expect(onPopoverHide).not.toHaveBeenCalled();
    expect(onPopoverAfterHide).not.toHaveBeenCalled();
    keydown(container.querySelectorAll("input")[1]!, "Enter");
    suggestionPopup.dispatchEvent(
      new CustomEvent("overlay-after-hide", { bubbles: true, composed: true }),
    );
    expect(onConfirm).not.toHaveBeenCalled();
    afterHide(container);
    expect(onConfirm).toHaveBeenCalledOnce();

    renderNamed("Not Valid");
    keydown(container.querySelectorAll("input")[1]!, "Enter");
    expect(onConfirm).toHaveBeenCalledOnce();

    const renderBranches = (names: string[]) =>
      update({
        ...params,
        branches: {
          repoRoot: "/repo",
          branches: names.map((name) => ({ name, kind: "local" })),
        },
      });
    const baseRef = query<HTMLInputElement>("#new-session-worktree-base-ref")!;
    renderBranches(["main", "release"]);
    keydown(baseRef, "ArrowDown");
    renderBranches(["release", "main"]);
    keydown(baseRef, "Enter");
    expect(params.onBaseRefInput).toHaveBeenLastCalledWith("main");

    keydown(baseRef, "ArrowDown");
    const retired = query<HTMLButtonElement>('[data-worktree-suggestion="release"]')!;
    renderBranches(["main", "next"]);
    expect(baseRef.hasAttribute("aria-activedescendant")).toBe(false);
    vi.mocked(params.onBaseRefInput).mockClear();
    retired.click();
    expect(params.onBaseRefInput).not.toHaveBeenCalled();
    keydown(baseRef, "ArrowDown");
    keydown(baseRef, "ArrowDown");
    keydown(baseRef, "Enter");
    expect(params.onBaseRefInput).toHaveBeenCalledExactlyOnceWith("next");
  });
});
