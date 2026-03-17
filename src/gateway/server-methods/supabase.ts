import { createClient } from "@supabase/supabase-js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

interface SupabaseInstance {
  url: string;
  key: string;
  schema?: string;
}

interface SupabaseConfig {
  instances: Record<string, SupabaseInstance>;
  defaultInstance?: string;
}

// TODO: Implement proper config write handlers using readConfigFileSnapshotForWrite/writeConfigFile
// For now, only read-only handlers are implemented

export const supabaseHandlers: GatewayRequestHandlers = {
  "supabase.testConnection": async ({ params, respond }: GatewayRequestHandlerOptions) => {
    const { instance } = params as { instance: SupabaseInstance };

    try {
      const client = createClient(instance.url, instance.key);

      // Simple query to test connection
      const { error } = await client.from("users").select("count", { count: "exact", head: true });

      if (error) {
        respond(true, {
          success: false,
          message: `Connection failed: ${error.message}`,
        });
      } else {
        respond(true, {
          success: true,
          message: "Connection successful! Supabase is reachable.",
        });
      }
    } catch (error) {
      respond(true, {
        success: false,
        message: `Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  },

  "supabase.getInstances": async ({ respond, context }: GatewayRequestHandlerOptions) => {
    const config = (context.config.supabase as SupabaseConfig | undefined) || { instances: {} };

    const instances = Object.entries(config.instances).map(([name, data]) => ({
      id: name,
      name,
      url: data.url,
      key: data.key,
      schema: data.schema,
      isDefault: name === config.defaultInstance,
    }));

    respond(true, { instances });
  },
};
