import {
  Activity,
  BarChart3,
  BookOpen,
  Brain,
  Bug,
  Database,
  Eye,
  FileText,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Heart,
  Link2,
  MessageSquare,
  Monitor,
  Package,
  Plug,
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
      title: "Projects",
      url: "/projects",
      icon: FolderKanban,
      subtitle: "Registered project workspaces",
    },
    {
      title: "Cron Jobs",
      url: "/cron",
      icon: Timer,
      subtitle: "Scheduled agent runs",
    },
    {
      title: "Heartbeat",
      url: "/heartbeat",
      icon: Heart,
      subtitle: "Periodic health checks",
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
      title: "Hub",
      url: "/hub",
      icon: Store,
      subtitle: "Browse and install hub items",
    },
    {
      title: "Commands",
      url: "/commands",
      icon: Terminal,
      subtitle: "Slash command registry",
    },
    {
      title: "Skills",
      url: "/skills",
      icon: Zap,
      subtitle: "Skill availability",
      items: [
        {
          title: "Installed",
          url: "/skills",
          icon: Package,
          subtitle: "Installed skills and status",
        },
        {
          title: "Marketplace",
          url: "/marketplace",
          icon: Store,
          subtitle: "Browse & install ClawHub skills",
        },
        {
          title: "Registries",
          url: "/skills/registries",
          icon: Database,
          subtitle: "Manage skill registries",
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
  mcp: [
    {
      title: "MCP Servers",
      url: "/mcp/installed",
      icon: Plug,
      subtitle: "External tool servers",
      items: [
        {
          title: "Browse",
          url: "/mcp/browse",
          icon: Store,
          subtitle: "Discover servers from registries",
        },
        {
          title: "Installed",
          url: "/mcp/installed",
          icon: Package,
          subtitle: "Manage connected servers",
        },
        {
          title: "Registries",
          url: "/mcp/registries",
          icon: Database,
          subtitle: "Server registries",
        },
        {
          title: "Health",
          url: "/mcp/health",
          icon: Activity,
          subtitle: "Server health status",
        },
      ],
    },
  ],
  docs: [
    {
      title: "Operator1 Docs",
      url: "/docs",
      icon: BookOpen,
      subtitle: "Operator1 documentation",
    },
    {
      title: "OpenClaw Docs",
      url: "/openclaw-docs",
      icon: BookOpen,
      subtitle: "Full OpenClaw documentation",
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
        <NavMain label="MCP" items={navData.mcp} />
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
