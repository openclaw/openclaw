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
const CommandsPage = lazy(() =>
  import("@/pages/commands").then((m) => ({ default: m.CommandsPage })),
);
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

const McpBrowsePage = lazy(() =>
  import("@/pages/mcp/browse").then((m) => ({ default: m.McpBrowsePage })),
);
const McpInstalledPage = lazy(() =>
  import("@/pages/mcp/installed").then((m) => ({ default: m.McpInstalledPage })),
);
const McpRegistriesPage = lazy(() =>
  import("@/pages/mcp/registries").then((m) => ({ default: m.McpRegistriesPage })),
);
const McpHealthPage = lazy(() =>
  import("@/pages/mcp/health").then((m) => ({ default: m.McpHealthPage })),
);

const SkillRegistriesPage = lazy(() =>
  import("@/pages/skills/registries").then((m) => ({ default: m.SkillRegistriesPage })),
);
const HeartbeatPage = lazy(() =>
  import("@/pages/heartbeat").then((m) => ({ default: m.HeartbeatPage })),
);
const MemoryPage = lazy(() => import("@/pages/memory").then((m) => ({ default: m.MemoryPage })));
const UsagePage = lazy(() => import("@/pages/usage").then((m) => ({ default: m.UsagePage })));
const VisualizePage = lazy(() =>
  import("@/pages/visualize").then((m) => ({ default: m.VisualizePage })),
);
const ProjectsPage = lazy(() =>
  import("@/pages/projects").then((m) => ({ default: m.ProjectsPage })),
);
const HubPage = lazy(() => import("@/pages/hub").then((m) => ({ default: m.HubPage })));
const DocsPage = lazy(() => import("@/pages/docs").then((m) => ({ default: m.DocsPage })));
const OpenClawDocsPage = lazy(() =>
  import("@/pages/openclaw-docs").then((m) => ({ default: m.OpenClawDocsPage })),
);

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
              path="/projects"
              element={
                <Suspense fallback={<PageLoader />}>
                  <ProjectsPage />
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
            <Route path="/mcp" element={<Navigate to="/mcp/installed" replace />} />
            <Route
              path="/mcp/browse"
              element={
                <Suspense fallback={<PageLoader />}>
                  <McpBrowsePage />
                </Suspense>
              }
            />
            <Route
              path="/mcp/installed"
              element={
                <Suspense fallback={<PageLoader />}>
                  <McpInstalledPage />
                </Suspense>
              }
            />
            <Route
              path="/mcp/registries"
              element={
                <Suspense fallback={<PageLoader />}>
                  <McpRegistriesPage />
                </Suspense>
              }
            />
            <Route
              path="/mcp/health"
              element={
                <Suspense fallback={<PageLoader />}>
                  <McpHealthPage />
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
              path="/skills/registries"
              element={
                <Suspense fallback={<PageLoader />}>
                  <SkillRegistriesPage />
                </Suspense>
              }
            />
            <Route
              path="/commands"
              element={
                <Suspense fallback={<PageLoader />}>
                  <CommandsPage />
                </Suspense>
              }
            />
            <Route
              path="/hub"
              element={
                <Suspense fallback={<PageLoader />}>
                  <HubPage />
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
              path="/heartbeat"
              element={
                <Suspense fallback={<PageLoader />}>
                  <HeartbeatPage />
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
              path="/docs/*"
              element={
                <Suspense fallback={<PageLoader />}>
                  <DocsPage />
                </Suspense>
              }
            />
            <Route
              path="/openclaw-docs"
              element={
                <Suspense fallback={<PageLoader />}>
                  <OpenClawDocsPage />
                </Suspense>
              }
            />
            <Route
              path="/openclaw-docs/*"
              element={
                <Suspense fallback={<PageLoader />}>
                  <OpenClawDocsPage />
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
