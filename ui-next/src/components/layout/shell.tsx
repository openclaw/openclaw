import { Outlet, useLocation } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { GatewayContext, useGatewayConnection } from "@/hooks/use-gateway";

const PAGE_TITLES: Record<string, string> = {
  "/chat": "Chat",
  "/overview": "Overview",
  "/channels": "Channels",
  "/instances": "Instances",
  "/sessions": "Sessions",
  "/cron": "Cron Jobs",
  "/agents": "Agents",
  "/memory": "Memory",
  "/skills": "Skills",
  "/nodes": "Nodes",
  "/config": "Config",
  "/debug": "Debug",
  "/logs": "Logs",
};

// Full-height pages get no padding and overflow-hidden
const FULL_HEIGHT_PAGES = new Set(["/chat", "/logs", "/config"]);

export function Shell() {
  const location = useLocation();
  const pageTitle = PAGE_TITLES[location.pathname] ?? "Operator";
  const isFullHeight = FULL_HEIGHT_PAGES.has(location.pathname);

  // Single gateway connection shared with all child pages via context
  const gateway = useGatewayConnection();

  return (
    <GatewayContext.Provider value={gateway}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="h-svh overflow-hidden">
          <header className="flex h-12 md:h-14 shrink-0 items-center gap-2 border-b px-3 md:px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage className="text-sm md:text-base">{pageTitle}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            {/* Portal target for page-specific header content */}
            <div id="shell-header-extra" className="flex items-center gap-2 ml-auto" />
          </header>
          <main
            className={
              isFullHeight ? "flex-1 overflow-hidden" : "flex-1 overflow-y-auto p-3 sm:p-4 md:p-6"
            }
          >
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </GatewayContext.Provider>
  );
}
