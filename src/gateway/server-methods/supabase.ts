import type { GatewayRequestHandlers } from "../types.js";
import { createClient } from "@supabase/supabase-js";

export const supabaseHandlers: GatewayRequestHandlers = {
  "supabase.saveInstance": async ({ params, respond, context }) => {
    const { instance } = params as { instance: any };
    
    // Validate
    if (!instance.name || !instance.url || !instance.key) {
      respond(false, undefined, { message: "Missing required fields" });
      return;
    }

    // Get current config
    const config = context.config.supabase || { instances: {} };
    
    // Save instance
    config.instances[instance.name] = {
      url: instance.url,
      key: instance.key,
      schema: instance.schema || "public",
    };

    // Update config
    await context.configManager.set({ supabase: config });

    respond(true, { success: true });
  },

  "supabase.deleteInstance": async ({ params, respond, context }) => {
    const { id } = params as { id: string };
    
    const config = context.config.supabase || { instances: {} };
    delete config.instances[id];
    
    await context.configManager.set({ supabase: config });
    respond(true, { success: true });
  },

  "supabase.setDefaultInstance": async ({ params, respond, context }) => {
    const { id } = params as { id: string };
    
    const config = context.config.supabase || { instances: {} };
    config.defaultInstance = id;
    
    await context.configManager.set({ supabase: config });
    respond(true, { success: true });
  },

  "supabase.testConnection": async ({ params, respond, context }) => {
    const { instance } = params as { instance: any };
    
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

  "supabase.getInstances": async ({ respond, context }) => {
    const config = context.config.supabase || { instances: {} };
    
    const instances = Object.entries(config.instances).map(([name, data]: [string, any]) => ({
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
