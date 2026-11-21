// Navigation prompt tests cover shared onboarding footer copy through the prompt renderer.
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";

type TestPromptOption = {
  value: unknown;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

type TestSelectPrompt = {
  state: "active";
  cursor: number;
  options: TestPromptOption[];
};

type TestConfirmPrompt = {
  state: "active";
  value: boolean;
};

vi.mock("@clack/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/core")>();
  return {
    ...actual,
    ConfirmPrompt: class {
      readonly state = "active" as const;
      readonly value: boolean;
      readonly render: () => string;

      constructor(params: { initialValue?: boolean; render: (this: TestConfirmPrompt) => string }) {
        this.value = params.initialValue ?? true;
        this.render = params.render.bind(this);
      }

      prompt(): Promise<string> {
        return Promise.resolve(this.render());
      }
    },
    SelectPrompt: class {
      readonly state = "active" as const;
      readonly cursor = 0;
      readonly options: TestPromptOption[];
      readonly render: () => string;

      constructor(params: {
        options: TestPromptOption[];
        render: (this: TestSelectPrompt) => string;
      }) {
        this.options = params.options;
        this.render = params.render.bind(this);
      }

      prompt(): Promise<string> {
        return Promise.resolve(this.render());
      }
    },
  };
});

import {
  confirmWithNavigationFooter,
  selectWithNavigationFooter,
} from "./clack-navigation-prompts.js";
import type { WizardPromptNavigation } from "./prompts.js";

const output = {
  columns: 80,
  write: () => true,
} as unknown as Writable;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderNavigationFooter(
  navigation: WizardPromptNavigation | undefined,
): Promise<string> {
  return stripAnsi(
    String(
      await selectWithNavigationFooter({
        message: "Pick one",
        options: [{ value: "one", label: "One" }],
        navigation,
        output,
      }),
    ),
  );
}

async function renderNavigationConfirmation(initialValue: boolean): Promise<string> {
  return stripAnsi(
    String(
      await confirmWithNavigationFooter({
        message: "Continue?",
        initialValue,
        navigation: { canGoBack: true },
        output,
      }),
    ),
  );
}

describe("navigation-aware select rendering", () => {
  it("omits navigation copy when no move is available", async () => {
    await expect(
      renderNavigationFooter({ canGoBack: false, canGoForward: false }),
    ).resolves.not.toMatch(/← back|→ next/u);
  });

  it("renders compact back and forward guidance", async () => {
    await expect(
      renderNavigationFooter({ canGoBack: true, canGoForward: true }),
    ).resolves.toContain("← back  → next  ↑/↓ option");
  });

  it("renders only the available navigation action", async () => {
    await expect(
      renderNavigationFooter({ canGoBack: true, canGoForward: false }),
    ).resolves.toContain("← back  ↑/↓ option");
    await expect(
      renderNavigationFooter({ canGoBack: false, canGoForward: true }),
    ).resolves.toContain("→ next  ↑/↓ option");
  });
});

describe("navigation-aware confirmation rendering", () => {
  it("renders localized confirmation choices", async () => {
    vi.stubEnv("OPENCLAW_LOCALE", "pt-PT");

    const rendered = await renderNavigationConfirmation(false);

    expect(rendered).toContain("Sim");
    expect(rendered).toContain("Não");
  });
});
