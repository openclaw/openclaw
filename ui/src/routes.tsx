import {
  createRouter,
  createRoute,
  createRootRoute,
  redirect,
  Outlet,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell";
import { ChatPage } from "@/pages/chat";
import { OverviewPage } from "@/pages/overview";
import { ChannelsPage } from "@/pages/channels";
import { InstancesPage } from "@/pages/instances";
import { SessionsPage } from "@/pages/sessions";
import { UsagePage } from "@/pages/usage";
import { CronPage } from "@/pages/cron";
import { AgentsPage } from "@/pages/agents";
import { AgentDetailPage } from "@/pages/agent-detail";
import { SkillsPage } from "@/pages/skills";
import { NodesPage } from "@/pages/nodes";
import { ConfigPage } from "@/pages/config";
import { CommunicationsPage } from "@/pages/communications";
import { AppearancePage } from "@/pages/appearance";
import { AutomationPage } from "@/pages/automation";
import { InfrastructurePage } from "@/pages/infrastructure";
import { AIAgentsPage } from "@/pages/ai-agents";
import { DebugPage } from "@/pages/debug";
import { LogsPage } from "@/pages/logs";

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/chat" });
  },
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatPage,
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/overview",
  component: OverviewPage,
});

const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channels",
  component: ChannelsPage,
});

const instancesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/instances",
  component: InstancesPage,
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: SessionsPage,
});

const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  component: UsagePage,
});

const cronRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cron",
  component: CronPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: AgentsPage,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$agentId",
  component: AgentDetailPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills",
  component: SkillsPage,
});

const nodesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/nodes",
  component: NodesPage,
});

const configRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/config",
  component: ConfigPage,
});

const communicationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/communications",
  component: CommunicationsPage,
});

const appearanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/appearance",
  component: AppearancePage,
});

const automationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/automation",
  component: AutomationPage,
});

const infrastructureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/infrastructure",
  component: InfrastructurePage,
});

const aiAgentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ai-agents",
  component: AIAgentsPage,
});

const debugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug",
  component: DebugPage,
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs",
  component: LogsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  overviewRoute,
  channelsRoute,
  instancesRoute,
  sessionsRoute,
  usageRoute,
  cronRoute,
  agentsRoute,
  agentDetailRoute,
  skillsRoute,
  nodesRoute,
  configRoute,
  communicationsRoute,
  appearanceRoute,
  automationRoute,
  infrastructureRoute,
  aiAgentsRoute,
  debugRoute,
  logsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
