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
const MarketplacePage = lazy(() =>
  import("@/pages/marketplace").then((m) => ({ default: m.MarketplacePage })),
);
const ConfigPage = lazy(() => import("@/pages/config").then((m) => ({ default: m.ConfigPage })));
const LogsPage = lazy(() => import("@/pages/logs").then((m) => ({ default: m.LogsPage })));
const DebugPage = lazy(() => import("@/pages/debug").then((m) => ({ default: m.DebugPage })));
const InstancesPage = lazy(() =>
  import("@/pages/instances").then((m) => ({ default: m.InstancesPage })),
);

const AgentBrowsePage = lazy(() =>
  import("@/pages/agents/browse").then((m) => ({ default: m.AgentBrowsePage })),
);
const AgentInstalledPage = lazy(() =>
  import("@/pages/agents/installed").then((m) => ({ default: m.AgentInstalledPage })),
);
const AgentRegistriesPage = lazy(() =>
  import("@/pages/agents/registries").then((m) => ({ default: m.AgentRegistriesPage })),
);
const AgentHealthPage = lazy(() =>
  import("@/pages/agents/health").then((m) => ({ default: m.AgentHealthPage })),
);
const AgentConfigPage = lazy(() =>
  import("@/pages/agents/config").then((m) => ({ default: m.AgentConfigPage })),
);
const AgentPreviewPage = lazy(() =>
  import("@/pages/agents/preview").then((m) => ({ default: m.AgentPreviewPage })),
);
const AgentOrganizationPage = lazy(() =>
  import("@/pages/agents/organization").then((m) => ({ default: m.AgentOrganizationPage })),
);
const MemoryPage = lazy(() => import("@/pages/memory").then((m) => ({ default: m.MemoryPage })));
const UsagePage = lazy(() => import("@/pages/usage").then((m) => ({ default: m.UsagePage })));
const VisualizePage = lazy(() =>
  import("@/pages/visualize").then((m) => ({ default: m.VisualizePage })),
);
const DocsPage = lazy(() => import("@/pages/docs").then((m) => ({ default: m.DocsPage })));

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
            <Route path="/agents" element={<Navigate to="/agents/organization" replace />} />
            <Route
              path="/agents/browse"
              element={
                <Suspense fallback={<PageLoader />}>
                  <AgentBrowsePage />
                </Suspense>
              }
            />
            <Route
              path="/agents/installed"
              element={
                <Suspense fallback={<PageLoader />}>
                  <AgentInstalledPage />
                </Suspense>
              }
            />
            <Route
              path="/agents/registries"
              element={
                <Suspense fallback={<PageLoader />}>
                  <AgentRegistriesPage />
                </Suspense>
              }
            />
            <Route
              path="/agents/health"
              element={
                <Suspense fallback={<PageLoader />}>
                  <AgentHealthPage />
                </Suspense>
              }
            />
            <Route
              path="/agents/config/:agentId"
              element={
                <Suspense fallback={<PageLoader />}>
                  <AgentConfigPage />
                </Suspense>
              }
            />
            <Route
              path="/agents/organization"
              element={
                <Suspense fallback={<PageLoader />}>
                  <AgentOrganizationPage />
                </Suspense>
              }
            />
            <Route
              path="/agents/preview/:agentId"
              element={
                <Suspense fallback={<PageLoader />}>
                  <AgentPreviewPage />
                </Suspense>
              }
            />
            <Route
              path="/visualize"
              element={
                <Suspense fallback={<PageLoader />}>
                  <VisualizePage />
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
              path="/marketplace"
              element={
                <Suspense fallback={<PageLoader />}>
                  <MarketplacePage />
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
            <Route
              path="/docs"
              element={
                <Suspense fallback={<PageLoader />}>
                  <DocsPage />
                </Suspense>
              }
            />
            <Route
              path="/docs/:slug"
              element={
                <Suspense fallback={<PageLoader />}>
                  <DocsPage />
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
