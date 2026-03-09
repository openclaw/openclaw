import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WorkMode = "working" | "gather" | "meeting" | "cooler";
export type Theme = "dark" | "light";

interface UIStore {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  workMode: WorkMode;
  setWorkMode: (mode: WorkMode) => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  simulationEnabled: boolean;
  setSimulationEnabled: (enabled: boolean) => void;
  theme: Theme;
  toggleTheme: () => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => void;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
}

export const useUIStore = create<UIStore>()(
  persist(
    (set, get) => ({
      activeTab: "office",
      setActiveTab: (tab) => set({ activeTab: tab }),
      workMode: "working",
      setWorkMode: (mode) => set({ workMode: mode }),
      searchOpen: false,
      setSearchOpen: (open) => set({ searchOpen: open }),
      chatOpen: false,
      setChatOpen: (open) => set({ chatOpen: open }),
      simulationEnabled: true,
      setSimulationEnabled: (enabled) => set({ simulationEnabled: enabled }),
      theme: "dark",
      toggleTheme: () => {
        const next = get().theme === "dark" ? "light" : "dark";
        set({ theme: next });
      },
      notificationsEnabled: false,
      setNotificationsEnabled: (enabled) => {
        if (enabled && "Notification" in window && Notification.permission !== "granted") {
          Notification.requestPermission();
        }
        set({ notificationsEnabled: enabled });
      },
      soundEnabled: true,
      setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
    }),
    { name: "mavis-ui" },
  ),
);
