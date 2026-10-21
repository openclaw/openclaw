import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resolveCheckoutChip } from "./checkout-chip.ts";
import { CheckoutChip } from "./checkout-chip.tsx";
import type { DraftRepositoryState } from "./discovery.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";

type CheckoutFixture = {
  state: ReturnType<typeof resolveCheckoutChip>;
  remotePlacement: boolean;
  currentCheckoutUnavailableReason?: string;
  repository?: boolean;
  folderLabel: string;
  worktree: boolean;
  worktreeAvailable: boolean;
  repositoryUnavailable?: boolean;
  branches: Omit<Extract<DraftRepositoryState, { kind: "git" }>, "kind"> | null;
  branchesLoading: boolean;
  baseRef: string;
  worktreeName: string;
  submitting: boolean;
  pendingPlacement: boolean;
  popoverOpen: boolean;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectWorktree: (value: boolean) => void;
  onBaseRefInput: (baseRef: string) => void;
  onWorktreeNameInput: (name: string) => void;
  onConfirm: () => void;
};

function mountCheckout(initial: CheckoutFixture) {
  const [params, setParams] = createSignal(initial);
  const { state: place, browser, gateway } = createRepositoryFixture();
  Object.defineProperties(place, {
    worktree: { get: () => params().worktree },
    worktreeName: { get: () => params().worktreeName },
    baseRef: { get: () => params().baseRef },
    remotePlacement: { get: () => params().remotePlacement },
    remoteRepository: {
      get: () => (params().repository ? { url: "https://example.com/repo.git" } : undefined),
    },
    currentCheckoutUnavailableReason: { get: () => params().currentCheckoutUnavailableReason },
    repository: {
      get: () => {
        const current = params();
        return current.branches
          ? { kind: "git", ...current.branches }
          : {
              kind: current.branchesLoading
                ? "checking"
                : current.repositoryUnavailable
                  ? "unavailable"
                  : "idle",
            };
      },
    },
  });
  vi.spyOn(place, "worktreeAvailable").mockImplementation(() => params().worktreeAvailable);
  vi.spyOn(place, "selectWorktree").mockImplementation((value) => params().onSelectWorktree(value));
  vi.spyOn(place, "setBaseRef").mockImplementation((value) => params().onBaseRefInput(value));
  vi.spyOn(place, "setWorktreeName").mockImplementation((value) =>
    params().onWorktreeNameInput(value),
  );
  vi.spyOn(browser, "popoverOpen").mockImplementation(() => params().popoverOpen);
  vi.spyOn(browser, "popoverCallbacks").mockImplementation(() => params());
  const options: NewSessionPlaceControlsOptions = {
    place,
    gateway,
    context: undefined,
    data: undefined,
    get submitting() {
      return params().submitting;
    },
    get pendingPlacement() {
      return params().pendingPlacement;
    },
    onConnectMachine: vi.fn(),
    onNavigate: vi.fn(),
    onChange: vi.fn(),
    onFocusComposer: () => params().onConfirm(),
  };
  const mounted = mountSolid(() =>
    createComponent(CheckoutChip, {
      params: options,
      get state() {
        return params().state;
      },
      get folderLabel() {
        return params().folderLabel;
      },
    }),
  );
  return {
    container: mounted.container,
    update: (next: CheckoutFixture) => {
      setParams(next);
      flush();
    },
  };
}

describe("Checkout chip state", () => {
  it.each([
    ...([false, true] as const).flatMap((repository) =>
      (["main", "release", ""] as const).map((baseRef) => ({
        destination: "cloud" as const,
        repository,
        worktree: !repository,
        baseRef,
        label: baseRef ? `From ${baseRef}` : "Starting branch",
      })),
    ),
    {
      destination: "remote",
      repository: true,
      worktree: false,
      baseRef: "release",
      label: "Remote checkout from release",
    },
    {
      destination: "remote",
      repository: true,
      worktree: false,
      baseRef: "",
      label: "Remote checkout",
    },
    {
      destination: "remote",
      worktree: true,
      baseRef: "",
      label: "New worktree",
    },
    {
      destination: "local",
      worktree: false,
      headBranch: "feature",
      baseRef: "main",
      label: "feature",
    },
    {
      destination: "local",
      worktree: false,
      baseRef: "main",
      label: "Current checkout",
    },
    {
      destination: "local",
      worktree: true,
      headBranch: "feature",
      baseRef: "main",
      label: "New worktree from main",
    },
    {
      destination: "local",
      worktree: true,
      baseRef: "",
      label: "New worktree",
    },
  ] as const)("$destination worktree=$worktree: $label", ({ label, ...params }) => {
    expect(resolveCheckoutChip({ worktreeName: "", ...params })).toEqual({ label });
  });

  it.each([
    {
      destination: "local",
      worktree: true,
      name: " release-proof ",
      label: "Worktree · release-proof",
    },
    {
      destination: "remote",
      worktree: true,
      name: "release-proof",
      label: "Worktree · release-proof",
    },
    { destination: "local", worktree: true, name: "   ", label: "New worktree from main" },
    { destination: "local", worktree: false, name: "release-proof", label: "main" },
    {
      destination: "cloud",
      worktree: true,
      name: "release-proof",
      label: "Worktree · release-proof",
    },
    {
      destination: "cloud",
      worktree: true,
      repository: true,
      name: "release-proof",
      label: "From main",
    },
    {
      destination: "remote",
      worktree: false,
      repository: true,
      name: "release-proof",
      label: "Remote checkout from main",
    },
  ] as const)(
    "labels $destination checkout with name=$name: $label",
    ({ name, label, ...params }) => {
      expect(
        resolveCheckoutChip({
          headBranch: "main",
          baseRef: "main",
          worktreeName: name,
          ...params,
        }),
      ).toEqual({ label });
    },
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
      const onSelectWorktree = vi.fn();
      const onBaseRefInput = vi.fn();
      const onWorktreeNameInput = vi.fn();
      const onConfirm = vi.fn();
      const { container } = mountCheckout({
        state: { label: worktree ? "New worktree from main" : "feature" },
        remotePlacement,
        currentCheckoutUnavailableReason,
        repository,
        folderLabel: "OpenClaw",
        worktree,
        worktreeAvailable: true,
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
        branchesLoading: false,
        baseRef: "main",
        worktreeName: "",
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        onPopoverShow: () => undefined,
        onPopoverHide: () => undefined,
        onPopoverAfterHide: () => undefined,
        onSelectWorktree,
        onBaseRefInput,
        onWorktreeNameInput,
        onConfirm,
      });

      await waitForSolid(() =>
        expect(
          container
            .querySelector(".new-session-page__checkout-popover")
            ?.getAttribute("data-phase"),
        ).toBe("open"),
      );

      if (worktree || repository) {
        const baseRef = container.querySelector("input")!;
        if (emptyBranches) {
          expect(baseRef.hasAttribute("role")).toBe(false);
          expect(baseRef.hasAttribute("aria-expanded")).toBe(false);
          expect(container.querySelector('[role="listbox"]')).toBeNull();
        } else {
          expect(baseRef.getAttribute("role")).toBe("combobox");
          expect(container.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe(
            "From",
          );
        }
      }

      if (repository) {
        expect(container.querySelector('[data-value="checkout"]')).toBeNull();
        expect(container.querySelector('[data-value="worktree"]')).toBeNull();
        const inputs = container.querySelectorAll<HTMLInputElement>("input");
        expect(inputs).toHaveLength(1);
        inputs[0]!.value = "release/next";
        inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onBaseRefInput).toHaveBeenCalledWith("release/next");
        inputs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        container
          .querySelector(".new-session-page__checkout-popover")!
          .dispatchEvent(new CustomEvent("overlay-after-hide"));
        expect(onConfirm).toHaveBeenCalledOnce();
        expect(container.textContent).toContain(
          "Clones OpenClaw on the selected runner. No Gateway checkout is created.",
        );
        return;
      }

      const current = container.querySelector<HTMLButtonElement>('[data-value="checkout"]')!;
      const isolated = container.querySelector<HTMLButtonElement>('[data-value="worktree"]')!;
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
        baseRef.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        baseRef.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
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
        baseRef.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(onBaseRefInput).toHaveBeenLastCalledWith("release/next");
        expect(onConfirm).not.toHaveBeenCalled();
        (suggestions[1] as HTMLButtonElement).click();
        expect(onBaseRefInput).toHaveBeenLastCalledWith("release/next");
        name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        container
          .querySelector(".new-session-page__checkout-popover")!
          .dispatchEvent(new CustomEvent("overlay-after-hide"));
        expect(onConfirm).toHaveBeenCalledOnce();
        container.querySelector<HTMLButtonElement>("#new-session-checkout-trigger")!.click();
        await waitForSolid(() =>
          expect(
            container
              .querySelector(".new-session-page__checkout-popover")
              ?.getAttribute("data-phase"),
          ).toBe("open"),
        );
        baseRef.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        const branchWrites = onBaseRefInput.mock.calls.length;
        name.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }),
        );
        container
          .querySelector(".new-session-page__checkout-popover")!
          .dispatchEvent(new CustomEvent("overlay-after-hide"));
        expect(onBaseRefInput).toHaveBeenCalledTimes(branchWrites);
        expect(onConfirm).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain(
          "Creates a branch from the session title in a separate checkout.",
        );
      } else {
        expect(container.querySelector(".new-session-page__menu-note")).toBeNull();
      }
      expect(container.textContent?.includes("Syncs OpenClaw to the selected runner")).toBe(
        remotePlacement,
      );
    },
  );

  it("keeps suggestion identities current and only confirms valid input", async () => {
    const onConfirm = vi.fn();
    const onPopoverShow = vi.fn();
    const onPopoverHide = vi.fn();
    const onPopoverAfterHide = vi.fn();
    const params: CheckoutFixture = {
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
      worktreeName: "picker-fixes",
      submitting: false,
      pendingPlacement: false,
      popoverOpen: true,
      onPopoverShow,
      onPopoverHide,
      onPopoverAfterHide,
      onSelectWorktree: vi.fn(),
      onBaseRefInput: vi.fn(),
      onWorktreeNameInput: vi.fn(),
      onConfirm,
    };
    const { container, update } = mountCheckout(params);
    const renderNamed = (worktreeName: string) => update({ ...params, worktreeName });
    await waitForSolid(() =>
      expect(
        container.querySelector(".new-session-page__checkout-popover")?.getAttribute("data-phase"),
      ).toBe("open"),
    );
    onPopoverShow.mockClear();

    const trigger = container.querySelector<HTMLButtonElement>("#new-session-checkout-trigger")!;
    expect(trigger.getAttribute("aria-controls")).toBe("new-session-checkout-popover");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.click();
    flush();
    expect(onPopoverHide).toHaveBeenCalledOnce();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.click();
    flush();
    await waitForSolid(() =>
      expect(
        container.querySelector(".new-session-page__checkout-popover")?.getAttribute("data-phase"),
      ).toBe("open"),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(onPopoverShow).toHaveBeenCalledOnce();
    expect(onPopoverAfterHide).not.toHaveBeenCalled();
    onPopoverShow.mockClear();
    onPopoverHide.mockClear();

    expect(container.textContent).toContain(
      "Creates branch openclaw/picker-fixes in a separate checkout.",
    );
    const suggestionPopup = container.querySelector(".new-session-page__branch-popup")!;
    for (const type of ["overlay-show", "overlay-hide", "overlay-after-hide"]) {
      suggestionPopup.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
    }
    expect(onPopoverShow).not.toHaveBeenCalled();
    expect(onPopoverHide).not.toHaveBeenCalled();
    expect(onPopoverAfterHide).not.toHaveBeenCalled();
    container
      .querySelectorAll("input")[1]!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    suggestionPopup.dispatchEvent(
      new CustomEvent("overlay-after-hide", { bubbles: true, composed: true }),
    );
    expect(onConfirm).not.toHaveBeenCalled();
    container
      .querySelector(".new-session-page__checkout-popover")!
      .dispatchEvent(new CustomEvent("overlay-after-hide"));
    expect(onConfirm).toHaveBeenCalledOnce();

    renderNamed("Not Valid");
    container
      .querySelectorAll("input")[1]!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onConfirm).toHaveBeenCalledOnce();

    const renderBranches = (names: string[]) =>
      update({
        ...params,
        branches: {
          repoRoot: "/repo",
          branches: names.map((name) => ({ name, kind: "local" })),
        },
      });
    const baseRef = container.querySelector<HTMLInputElement>("#new-session-worktree-base-ref")!;
    const keydown = (key: string) =>
      baseRef.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    renderBranches(["main", "release"]);
    keydown("ArrowDown");
    renderBranches(["release", "main"]);
    keydown("Enter");
    expect(params.onBaseRefInput).toHaveBeenLastCalledWith("main");

    keydown("ArrowDown");
    const retired = container.querySelector<HTMLButtonElement>(
      '[data-worktree-suggestion="release"]',
    )!;
    renderBranches(["main", "next"]);
    expect(baseRef.hasAttribute("aria-activedescendant")).toBe(false);
    vi.mocked(params.onBaseRefInput).mockClear();
    retired.click();
    expect(params.onBaseRefInput).not.toHaveBeenCalled();
    keydown("ArrowDown");
    keydown("ArrowDown");
    keydown("Enter");
    expect(params.onBaseRefInput).toHaveBeenCalledExactlyOnceWith("next");
  });
});
