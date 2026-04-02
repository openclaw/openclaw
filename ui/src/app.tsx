import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { GatewayProvider } from "@/components/layout/gateway-provider";
import { router } from "@/routes";

export function App() {
  return (
    <GatewayProvider>
      <RouterProvider router={router} />
      <Toaster />
    </GatewayProvider>
  );
}
