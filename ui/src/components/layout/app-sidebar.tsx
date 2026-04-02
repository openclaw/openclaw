import { Link, useLocation } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
} from "@/components/ui/sidebar";

const chatItems = [{ title: "Chat", path: "/chat" }];

const controlItems = [
  { title: "Overview", path: "/overview" },
  { title: "Channels", path: "/channels" },
  { title: "Instances", path: "/instances" },
  { title: "Sessions", path: "/sessions" },
  { title: "Usage", path: "/usage" },
  { title: "Cron", path: "/cron" },
];

const agentItems = [
  { title: "Agents", path: "/agents" },
  { title: "Skills", path: "/skills" },
  { title: "Nodes", path: "/nodes" },
];

const settingsItems = [
  { title: "Config", path: "/config" },
  { title: "Communications", path: "/communications" },
  { title: "Appearance", path: "/appearance" },
  { title: "Automation", path: "/automation" },
  { title: "Infrastructure", path: "/infrastructure" },
  { title: "AI Agents", path: "/ai-agents" },
  { title: "Debug", path: "/debug" },
  { title: "Logs", path: "/logs" },
];

function NavGroup({
  label,
  items,
}: {
  label: string;
  items: { title: string; path: string }[];
}) {
  const location = useLocation();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.path}>
              <SidebarMenuButton
                render={<Link to={item.path} />}
                isActive={location.pathname === item.path}
              >
                {item.title}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <h1 className="text-lg font-semibold">OpenClaw</h1>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="Chat" items={chatItems} />
        <NavGroup label="Control" items={controlItems} />
        <NavGroup label="Agents" items={agentItems} />
        <NavGroup label="Settings" items={settingsItems} />
      </SidebarContent>
    </Sidebar>
  );
}
