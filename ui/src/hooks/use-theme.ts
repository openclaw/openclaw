import { useState, useEffect, useCallback } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "openclaw-theme";

function getEffectiveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem(STORAGE_KEY) as Theme) ?? "system";
  });

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem(STORAGE_KEY, newTheme);
    const effective = getEffectiveTheme(newTheme);
    document.documentElement.classList.toggle("dark", effective === "dark");
  }, []);

  useEffect(() => {
    const effective = getEffectiveTheme(theme);
    document.documentElement.classList.toggle("dark", effective === "dark");
  }, [theme]);

  return { theme, setTheme, effectiveTheme: getEffectiveTheme(theme) };
}
