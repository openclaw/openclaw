import {
  Activity,
  BarChart3,
  BookOpen,
  Brain,
  Bug,
  Database,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  Link2,
  MessageSquare,
  Monitor,
  Package,
  Radio,
  ScrollText,
  Settings,
  Store,
  Timer,
  TrendingUp,
  Zap,
  Terminal,
} from "lucide-react";
import * as React from "react";
import { NavMain } from "@/components/nav-main";
import { NavStatus } from "@/components/nav-status";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const navData = {
  chat: [
    {
      title: "Chat",
      url: "/chat",
      icon: MessageSquare,
      subtitle: "Direct gateway chat session",
    },
  ],
  control: [
    {
      title: "Overview",
      url: "/overview",
      icon: BarChart3,
      subtitle: "Gateway status and metrics",
    },
    {
      title: "Channels",
      url: "/channels",
      icon: Link2,
      subtitle: "Manage channels and settings",
    },
    {
      title: "Instances",
      url: "/instances",
      icon: Radio,
      subtitle: "Connected clients and nodes",
    },
    {
      title: "Sessions",
      url: "/sessions",
      icon: FileText,
      subtitle: "Active sessions",
    },
    {
      title: "Cron Jobs",
      url: "/cron",
      icon: Timer,
      subtitle: "Scheduled agent runs",
    },
    {
      title: "Usage",
      url: "/usage",
      icon: TrendingUp,
      subtitle: "Token and cost analytics",
    },
  ],
  agent: [
    {
      title: "Agents",
      url: "/agents/organization",
      icon: FolderOpen,
      subtitle: "Agent organization and workspaces",
      items: [
        {
          title: "Browse",
          url: "/agents/browse",
          icon: Store,
          subtitle: "Registry blueprints and bundles",
        },
        {
          title: "Organization",
          url: "/agents/organization",
          icon: GitBranch,
          subtitle: "Deployed agent hierarchy",
        },
        {
          title: "Installed",
          url: "/agents/installed",
          icon: Package,
          subtitle: "Agent workspaces and files",
        },
        {
          title: "Registries",
          url: "/agents/registries",
          icon: Database,
          subtitle: "Manage agent registries",
        },
        {
          title: "Health",
          url: "/agents/health",
          icon: Activity,
          subtitle: "Agent health status",
        },
      ],
    },
    {
      title: "Visualize",
      url: "/visualize",
      icon: Eye,
      subtitle: "Matrix agent visualization",
    },
    {
      title: "Memory",
      url: "/memory",
      icon: Brain,
      subtitle: "Memory files, search, and index",
    },
    {
      title: "Skills",
      url: "/skills",
      icon: Zap,
      subtitle: "Skill availability",
      items: [
        {
          title: "Marketplace",
          url: "/marketplace",
          icon: Store,
          subtitle: "Browse & install ClawHub skills",
        },
      ],
    },
    {
      title: "Nodes",
      url: "/nodes",
      icon: Monitor,
      subtitle: "Paired devices",
    },
  ],
  docs: [
    {
      title: "Docs",
      url: "/docs",
      icon: BookOpen,
      subtitle: "Operator1 documentation",
    },
  ],
  settings: [
    {
      title: "Config",
      url: "/config",
      icon: Settings,
      subtitle: "Gateway configuration",
    },
    {
      title: "Debug",
      url: "/debug",
      icon: Bug,
      subtitle: "Snapshots, events, RPC",
    },
    {
      title: "Logs",
      url: "/logs",
      icon: ScrollText,
      subtitle: "Live gateway logs",
    },
  ],
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="/overview">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Terminal className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-mono font-bold tracking-wider">OPERATOR</span>
                  <span className="truncate text-xs text-muted-foreground">v{__APP_VERSION__}</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="Chat" items={navData.chat} />
        <NavMain label="Control" items={navData.control} defaultOpen />
        <NavMain label="Agent" items={navData.agent} />
        <NavMain label="Docs" items={navData.docs} />
        <NavMain label="Settings" items={navData.settings} />
      </SidebarContent>
      <SidebarFooter>
        <NavStatus />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
