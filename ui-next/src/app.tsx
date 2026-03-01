import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Shell } from "@/components/layout/shell";
import { PageLoader } from "@/components/ui/custom/page-loader";
import { ToastProvider } from "@/components/ui/custom/toast";

// Lazy-loaded pages — each becomes its own chunk
const OverviewPage = lazy(() =>
  import("@/pages/overview").then((m) => ({ default: m.OverviewPage })),
);
const ChatPage = lazy(() => import("@/pages/chat").then((m) => ({ default: m.ChatPage })));
const SessionsPage = lazy(() =>
  import("@/pages/sessions").then((m) => ({ default: m.SessionsPage })),
);
const ChannelsPage = lazy(() =>
  import("@/pages/channels").then((m) => ({ default: m.ChannelsPage })),
);
const CronPage = lazy(() => import("@/pages/cron").then((m) => ({ default: m.CronPage })));
const NodesPage = lazy(() => import("@/pages/nodes").then((m) => ({ default: m.NodesPage })));
const SkillsPage = lazy(() => import("@/pages/skills").then((m) => ({ default: m.SkillsPage })));
const ConfigPage = lazy(() => import("@/pages/config").then((m) => ({ default: m.ConfigPage })));
const LogsPage = lazy(() => import("@/pages/logs").then((m) => ({ default: m.LogsPage })));
const DebugPage = lazy(() => import("@/pages/debug").then((m) => ({ default: m.DebugPage })));
const InstancesPage = lazy(() =>
  import("@/pages/instances").then((m) => ({ default: m.InstancesPage })),
);

const AgentsPage = lazy(() => import("@/pages/agents").then((m) => ({ default: m.AgentsPage })));
const MemoryPage = lazy(() => import("@/pages/memory").then((m) => ({ default: m.MemoryPage })));
const UsagePage = lazy(() => import("@/pages/usage").then((m) => ({ default: m.UsagePage })));

export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route
              path="/overview"
              element={
                <Suspense fallback={<PageLoader />}>
                  <OverviewPage />
                </Suspense>
              }
            />
            <Route
              path="/chat"
              element={
                <Suspense fallback={<PageLoader />}>
                  <ChatPage />
                </Suspense>
              }
            />
            <Route
              path="/channels"
              element={
                <Suspense fallback={<PageLoader />}>
                  <ChannelsPage />
                </Suspense>
              }
            />
            <Route
              path="/instances"
              element={
                <Suspense fallback={<PageLoader />}>
                  <InstancesPage />
                </Suspense>
              }
            />
            <Route
              path="/sessions"
              element={
                <Suspense fallback={<PageLoader />}>
                  <SessionsPage />
                </Suspense>
              }
            />
            <Route
              path="/cron"
              element={
                <Suspense fallback={<PageLoader />}>
                  <CronPage />
                </Suspense>
              }
            />
            <Route
              path="/agents"
              element={
                <Suspense fallback={<PageLoader />}>
                  <AgentsPage />
                </Suspense>
              }
            />
            <Route
              path="/skills"
              element={
                <Suspense fallback={<PageLoader />}>
                  <SkillsPage />
                </Suspense>
              }
            />
            <Route
              path="/nodes"
              element={
                <Suspense fallback={<PageLoader />}>
                  <NodesPage />
                </Suspense>
              }
            />
            <Route
              path="/memory"
              element={
                <Suspense fallback={<PageLoader />}>
                  <MemoryPage />
                </Suspense>
              }
            />
            <Route
              path="/usage"
              element={
                <Suspense fallback={<PageLoader />}>
                  <UsagePage />
                </Suspense>
              }
            />
            <Route
              path="/config"
              element={
                <Suspense fallback={<PageLoader />}>
                  <ConfigPage />
                </Suspense>
              }
            />
            <Route
              path="/debug"
              element={
                <Suspense fallback={<PageLoader />}>
                  <DebugPage />
                </Suspense>
              }
            />
            <Route
              path="/logs"
              element={
                <Suspense fallback={<PageLoader />}>
                  <LogsPage />
                </Suspense>
              }
            />
            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
