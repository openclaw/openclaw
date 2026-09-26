import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderCheckoutChip, resolveCheckoutChip } from "./checkout-chip.ts";

describe("Checkout chip state", () => {
  it.each([
    ...([false, true] as const).flatMap((repository) =>
      (["main", "release", ""] as const).map((baseRef) => ({
        destination: "cloud" as const,
        repository,
        worktree: !repository,
        worktreeAvailable: true,
        baseRef,
        label: baseRef ? `From ${baseRef}` : "Starting branch",
      })),
    ),
    {
      destination: "remote",
      repository: true,
      worktree: false,
      worktreeAvailable: true,
      baseRef: "release",
      label: "Remote checkout from release",
    },
    {
      destination: "remote",
      repository: true,
      worktree: false,
      worktreeAvailable: true,
      baseRef: "",
      label: "Remote checkout",
    },
    {
      destination: "remote",
      worktree: true,
      worktreeAvailable: false,
      baseRef: "",
      label: "New worktree",
    },
    { destination: "local", worktree: false, worktreeAvailable: false, baseRef: "", label: null },
    {
      destination: "local",
      worktree: false,
      worktreeAvailable: true,
      headBranch: "feature",
      baseRef: "main",
      label: "feature",
    },
    {
      destination: "local",
      worktree: false,
      worktreeAvailable: true,
      baseRef: "main",
      label: "Current checkout",
    },
    {
      destination: "local",
      worktree: true,
      worktreeAvailable: true,
      headBranch: "feature",
      baseRef: "main",
      label: "New worktree from main",
    },
    {
      destination: "local",
      worktree: true,
      worktreeAvailable: false,
      baseRef: "",
      label: "New worktree",
    },
  ] as const)(
    "$destination worktree=$worktree available=$worktreeAvailable: $label",
    ({ label, ...params }) => {
      expect(resolveCheckoutChip(params)).toEqual(label === null ? null : { label });
    },
  );

  it.each([
    { worktree: false, remotePlacement: false, repository: false },
    { worktree: true, remotePlacement: false, repository: false },
    { worktree: true, remotePlacement: true, repository: false },
    { worktree: false, remotePlacement: true, repository: true },
    { worktree: false, remotePlacement: true, repository: true, emptyBranches: true },
    {
      worktree: true,
      remotePlacement: false,
      repository: false,
      idPrefix: "palette-session-1",
    },
  ])(
    "offers explicit checkout choices (worktree=$worktree, remote=$remotePlacement, emptyBranches=$emptyBranches)",
    ({ worktree, remotePlacement, repository, idPrefix, emptyBranches }) => {
      const container = document.createElement("div");
      const onSelectWorktree = vi.fn();
      const onBaseRefInput = vi.fn();
      const onWorktreeNameInput = vi.fn();
      const onConfirm = vi.fn();
      render(
        renderCheckoutChip({
          idPrefix,
          state: { label: worktree ? "New worktree from main" : "feature" },
          remotePlacement,
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
          popoverHiding: false,
          onGuardTransition: () => undefined,
          onPopoverShow: () => undefined,
          onPopoverHide: () => undefined,
          onPopoverAfterHide: () => undefined,
          onSelectWorktree,
          onBaseRefInput,
          onWorktreeNameInput,
          onConfirm,
        }),
        container,
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
        inputs[0]!.dispatchEvent(new Event("input"));
        expect(onBaseRefInput).toHaveBeenCalledWith("release/next");
        inputs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        container.querySelector("wa-popover")!.dispatchEvent(new CustomEvent("wa-after-hide"));
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
      expect(current.getAttribute("aria-pressed")).toBe(String(!worktree));
      expect(current.disabled).toBe(remotePlacement);
      expect(current.getAttribute("title")).toBe(
        remotePlacement ? "Devices and cloud run in a worktree" : null,
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
      expect(onSelectWorktree.mock.calls).toEqual(remotePlacement ? [[true]] : [[false], [true]]);

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
        baseRef.dispatchEvent(new Event("input"));
        name.value = " checkout-proof ";
        name.dispatchEvent(new Event("input"));
        expect(onBaseRefInput).toHaveBeenCalledWith(" release ");
        expect(onWorktreeNameInput).toHaveBeenCalledWith(" checkout-proof ");
        const suggestions = container.querySelectorAll("[data-worktree-suggestion]");
        expect([...suggestions].map((item) => item.textContent?.trim())).toEqual([
          "main",
          "release/next",
        ]);
        baseRef.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        baseRef.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        expect(baseRef.getAttribute("aria-activedescendant")).toBe(
          `${idPrefix ?? "new-session"}-worktree-branch-suggestion-1`,
        );
        expect(suggestions[1]!.getAttribute("aria-selected")).toBe("true");
        for (const key of ["ArrowDown", "ArrowUp"]) {
          const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
          name.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(false);
          expect(name.hasAttribute("aria-activedescendant")).toBe(false);
          expect(suggestions[1]!.getAttribute("aria-selected")).toBe("true");
        }
        baseRef.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        expect(onBaseRefInput).toHaveBeenLastCalledWith("release/next");
        expect(onConfirm).not.toHaveBeenCalled();
        (suggestions[1] as HTMLButtonElement).click();
        expect(onBaseRefInput).toHaveBeenLastCalledWith("release/next");
        name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        container.querySelector("wa-popover")!.dispatchEvent(new CustomEvent("wa-after-hide"));
        expect(onConfirm).toHaveBeenCalledOnce();
        baseRef.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        const branchWrites = onBaseRefInput.mock.calls.length;
        name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
        container.querySelector("wa-popover")!.dispatchEvent(new CustomEvent("wa-after-hide"));
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

  it("shows the actual branch name and only confirms valid input", () => {
    const container = document.createElement("div");
    const onConfirm = vi.fn();
    const onPopoverShow = vi.fn();
    const onPopoverHide = vi.fn();
    const onPopoverAfterHide = vi.fn();
    const renderNamed = (worktreeName: string) =>
      render(
        renderCheckoutChip({
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
          worktreeName,
          submitting: false,
          pendingPlacement: false,
          popoverOpen: true,
          popoverHiding: false,
          onGuardTransition: vi.fn(),
          onPopoverShow,
          onPopoverHide,
          onPopoverAfterHide,
          onSelectWorktree: vi.fn(),
          onBaseRefInput: vi.fn(),
          onWorktreeNameInput: vi.fn(),
          onConfirm,
        }),
        container,
      );

    renderNamed("picker-fixes");
    expect(container.textContent).toContain(
      "Creates branch openclaw/picker-fixes in a separate checkout.",
    );
    const suggestionPopup = container.querySelector("wa-popup")!;
    for (const type of ["wa-show", "wa-hide", "wa-after-hide"]) {
      suggestionPopup.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
    }
    expect(onPopoverShow).not.toHaveBeenCalled();
    expect(onPopoverHide).not.toHaveBeenCalled();
    expect(onPopoverAfterHide).not.toHaveBeenCalled();
    container
      .querySelectorAll("input")[1]!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    suggestionPopup.dispatchEvent(
      new CustomEvent("wa-after-hide", { bubbles: true, composed: true }),
    );
    expect(onConfirm).not.toHaveBeenCalled();
    container.querySelector("wa-popover")!.dispatchEvent(new CustomEvent("wa-after-hide"));
    expect(onConfirm).toHaveBeenCalledOnce();

    renderNamed("Not Valid");
    container
      .querySelectorAll("input")[1]!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onConfirm).toHaveBeenCalledOnce();

    renderNamed("picker-fixes");
    document.body.append(container);
    const name = container.querySelectorAll("input")[1]!;
    name.focus();
    name.setSelectionRange(0, 6);
    name.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    const hide = new CustomEvent("wa-hide", { bubbles: true, cancelable: true });
    container.querySelector("wa-popover")!.dispatchEvent(hide);
    expect(hide.defaultPrevented).toBe(true);
    expect(onPopoverHide).not.toHaveBeenCalled();
    container.remove();
  });
});
