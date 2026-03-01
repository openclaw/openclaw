import {
  BarChart3,
  Brain,
  Bug,
  FileText,
  FolderOpen,
  Link2,
  MessageSquare,
  Monitor,
  Radio,
  ScrollText,
  Settings,
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
      url: "/agents",
      icon: FolderOpen,
      subtitle: "Agent workspaces and identities",
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
    },
    {
      title: "Nodes",
      url: "/nodes",
      icon: Monitor,
      subtitle: "Paired devices",
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
        <NavMain label="Settings" items={navData.settings} />
      </SidebarContent>
      <SidebarFooter>
        <NavStatus />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
