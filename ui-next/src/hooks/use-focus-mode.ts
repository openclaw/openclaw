import { useState, useCallback, useEffect } from "react";
import { loadSettings, saveSettings } from "@/lib/storage";

/**
 * Manages focus mode state, persisted in localStorage.
 * Focus mode hides non-essential UI for a distraction-free chat experience.
 */
export function useFocusMode() {
  const [focusMode, setFocusModeRaw] = useState(() => loadSettings().chatFocusMode);

  const setFocusMode = useCallback((enabled: boolean) => {
    setFocusModeRaw(enabled);
    const s = loadSettings();
    s.chatFocusMode = enabled;
    saveSettings(s);
  }, []);

  const toggleFocusMode = useCallback(() => {
    setFocusMode(!focusMode);
  }, [focusMode, setFocusMode]);

  // Keyboard shortcut: Cmd+Shift+F (Mac) / Ctrl+Shift+F (Windows)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key === "F") {
        e.preventDefault();
        setFocusModeRaw((prev) => {
          const next = !prev;
          const s = loadSettings();
          s.chatFocusMode = next;
          saveSettings(s);
          return next;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return { focusMode, setFocusMode, toggleFocusMode };
}
