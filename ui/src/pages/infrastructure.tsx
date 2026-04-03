import { ConfigSectionPage } from "@/components/shared/config-section-page";

export function InfrastructurePage() {
  return (
    <ConfigSectionPage
      title="Infrastructure"
      section="gateway"
      fields={[
        { key: "port", label: "Gateway Port", type: "number" },
        { key: "hostname", label: "Hostname", type: "text" },
        { key: "tls.enabled", label: "TLS Enabled", type: "boolean" },
        { key: "maxConnections", label: "Max Connections", type: "number" },
        {
          key: "requestTimeout",
          label: "Request Timeout (ms)",
          type: "number",
        },
      ]}
    />
  );
}
