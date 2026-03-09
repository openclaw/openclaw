import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { BottomDock } from "@/components/layout/BottomDock";
import { MobileNav } from "@/components/layout/MobileNav";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { SearchOverlay } from "@/components/overlays/SearchOverlay";
import { ShortcutsOverlay, useKeyboardShortcuts } from "@/components/overlays/ShortcutsOverlay";
import { StartChatDrawer } from "@/components/overlays/StartChatDrawer";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSimulation } from "@/lib/simulation";
import { useUIStore } from "@/store/uiStore";

// Lazy-loaded pages
const OkoPage = lazy(() => import("@/pages/OkoPage"));
const OfficePage = lazy(() => import("@/pages/OfficePage"));
const TasksPage = lazy(() => import("@/pages/TasksPage"));
const ControlsPage = lazy(() => import("@/pages/ControlsPage"));
const CouncilPage = lazy(() => import("@/pages/CouncilPage"));
const ContentPage = lazy(() => import("@/pages/ContentPage"));
const ApprovalsPage = lazy(() => import("@/pages/ApprovalsPage"));
const CalendarPage = lazy(() => import("@/pages/CalendarPage"));
const ProjectsPage = lazy(() => import("@/pages/ProjectsPage"));
const MemoryPage = lazy(() => import("@/pages/MemoryPage"));
const DocsPage = lazy(() => import("@/pages/DocsPage"));
const PeoplePage = lazy(() => import("@/pages/PeoplePage"));
const TeamPage = lazy(() => import("@/pages/TeamPage"));
const AnalyticsPage = lazy(() => import("@/pages/AnalyticsPage"));
const AgencyPage = lazy(() => import("@/pages/AgencyPage"));
const PlaybooksPage = lazy(() => import("@/pages/PlaybooksPage"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

function PageLoader() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="glass-panel p-6 mb-6 space-y-2">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="glass-panel p-4 space-y-3">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2 w-1/2" />
            <Skeleton className="h-6 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

function AppContent() {
  useSimulation();
  const theme = useUIStore((s) => s.theme);
  const { shortcutsOpen, setShortcutsOpen } = useKeyboardShortcuts();

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-void">
      <Topbar />
      <Sidebar />
      <main className="fixed top-14 bottom-14 md:bottom-16 left-0 md:left-16 right-0 overflow-y-auto scrollbar-thin p-3 sm:p-4 md:p-6">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Navigate to="/oko" replace />} />
            <Route path="/oko" element={<OkoPage />} />
            <Route path="/office" element={<OfficePage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/controls" element={<ControlsPage />} />
            <Route path="/council" element={<CouncilPage />} />
            <Route path="/content" element={<ContentPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/agency" element={<AgencyPage />} />
            <Route path="/playbooks" element={<PlaybooksPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
      <div className="hidden md:block">
        <BottomDock />
      </div>
      <MobileNav />
      <SearchOverlay />
      <StartChatDrawer />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
