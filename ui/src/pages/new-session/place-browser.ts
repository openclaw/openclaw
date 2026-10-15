import type { PlaceBrowserState } from "./place-browser-state.ts";

export type PlaceBrowserOptions = {
  browser: PlaceBrowserState;
  id: string;
  label: string;
  registerProjectPath: string | null;
  registeringProject: boolean;
  onBack: () => void;
  onRegisterProject: (path: string) => void;
  onClose: () => void;
  onApplyFolder: (path: string) => void;
};
