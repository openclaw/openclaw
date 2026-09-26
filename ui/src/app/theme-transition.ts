import type { ResolvedTheme } from "./theme.ts";

type ThemeTransitionOptions = {
  nextTheme: ResolvedTheme;
  applyTheme: () => void;
  currentTheme?: ResolvedTheme | null;
};

export const startThemeTransition = ({
  nextTheme,
  applyTheme,
  currentTheme,
}: ThemeTransitionOptions) => {
  const root = currentTheme !== nextTheme ? globalThis.document?.documentElement : undefined;
  // Persist explicit selection even when the resolved palette is unchanged.
  applyTheme();
  if (root) {
    root.classList.remove("theme-transition");
    root.style.removeProperty("--theme-switch-x");
    root.style.removeProperty("--theme-switch-y");
  }
};
