export interface SupabaseInstanceConfig {
  id: string;
  name: string;
  url: string;
  key: string;
  schema?: string;
  isDefault?: boolean;
}

type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export async function getSupabaseInstances(request: RequestFn): Promise<SupabaseInstanceConfig[]> {
  const response = await request("supabase.getInstances", {});
  return (response as any).instances || [];
}

export async function saveSupabaseInstance(
  request: RequestFn,
  instance: SupabaseInstanceConfig
): Promise<void> {
  await request("supabase.saveInstance", { instance });
}

export async function deleteSupabaseInstance(
  request: RequestFn,
  id: string
): Promise<void> {
  await request("supabase.deleteInstance", { id });
}

export async function setDefaultSupabaseInstance(
  request: RequestFn,
  id: string
): Promise<void> {
  await request("supabase.setDefaultInstance", { id });
}

export async function testSupabaseConnection(
  request: RequestFn,
  instance: SupabaseInstanceConfig
): Promise<{ success: boolean; message: string }> {
  try {
    const response = await request("supabase.testConnection", {
      instance,
    });
    return response as { success: boolean; message: string };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
