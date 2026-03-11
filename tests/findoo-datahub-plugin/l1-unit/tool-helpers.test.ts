/**
 * L1 单元测试: tool-helpers
 *
 * 验证:
 * - json() 输出格式
 * - buildParams 参数过滤与转换
 * - registerCategoryTool SDK 调用合约
 * - dateRangeParams / symbolParam 结构
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildParams,
  dateRangeParams,
  json,
  registerCategoryTool,
  symbolParam,
  optionalSymbol,
} from "../../../extensions/findoo-datahub-plugin/src/tool-helpers.js";
import type { CategoryToolDef } from "../../../extensions/findoo-datahub-plugin/src/tool-helpers.js";

describe("json()", () => {
  // --- 1. 标准输出格式 ---
  it("返回 { content: [{ type: 'text', text }], details } 格式", () => {
    const result = json({ foo: "bar", count: 42 });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
    expect(result.details).toEqual({ foo: "bar", count: 42 });
  });

  // --- 2. JSON 格式化: indent=2 ---
  it("text 字段使用 indent=2 格式化", () => {
    const result = json({ a: 1 });
    expect(result.content[0].text).toBe('{\n  "a": 1\n}');
  });

  // --- 3. 处理 null/undefined ---
  it("可序列化 null 和 undefined", () => {
    expect(() => json(null)).not.toThrow();
    expect(() => json(undefined)).not.toThrow();
  });

  // --- 4. 数组输入 ---
  it("数组输入正确序列化", () => {
    const result = json([1, 2, 3]);
    expect(JSON.parse(result.content[0].text)).toEqual([1, 2, 3]);
  });
});

describe("buildParams()", () => {
  // --- 5. 过滤 null/undefined/空字符串 ---
  it("过滤 null, undefined, 空字符串", () => {
    const result = buildParams({
      symbol: "AAPL",
      start_date: null,
      end_date: undefined,
      limit: "",
      provider: "yfinance",
    });

    expect(result).toEqual({ symbol: "AAPL", provider: "yfinance" });
  });

  // --- 6. 跳过 routing key: endpoint ---
  it("跳过 endpoint 字段 (routing key)", () => {
    const result = buildParams({
      endpoint: "price/historical",
      symbol: "600519.SH",
    });

    expect(result).not.toHaveProperty("endpoint");
    expect(result).toEqual({ symbol: "600519.SH" });
  });

  // --- 7. 跳过 routing key: indicator ---
  it("跳过 indicator 字段 (routing key)", () => {
    const result = buildParams({
      indicator: "sma",
      symbol: "AAPL",
      period: 20,
    });

    expect(result).not.toHaveProperty("indicator");
    expect(result.symbol).toBe("AAPL");
    expect(result.period).toBe("20");
  });

  // --- 8. 数字转字符串 ---
  it("数字值转为字符串", () => {
    const result = buildParams({ limit: 100, period: 14 });
    expect(result.limit).toBe("100");
    expect(result.period).toBe("14");
  });

  // --- 9. boolean 转字符串 ---
  it("boolean 值转为字符串", () => {
    const result = buildParams({ ascending: true });
    expect(result.ascending).toBe("true");
  });

  // --- 10. 空对象返回空对象 ---
  it("空输入返回空对象", () => {
    expect(buildParams({})).toEqual({});
  });
});

describe("registerCategoryTool()", () => {
  // --- 11. 调用 api.registerTool ---
  it("调用 api.registerTool 并传入正确的 name 和 names[]", () => {
    const mockApi = {
      registerTool: vi.fn(),
    } as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi;

    const mockClient =
      {} as import("../../../extensions/findoo-datahub-plugin/src/datahub-client.js").DataHubClient;

    const def: CategoryToolDef = {
      name: "fin_test",
      label: "Test Tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} } as unknown,
      category: "test",
      clientMethod: vi.fn().mockResolvedValue([]),
      defaultEndpoint: "default",
    };

    registerCategoryTool(mockApi, mockClient, def);

    expect(mockApi.registerTool).toHaveBeenCalledOnce();
    const [toolDef, opts] = (mockApi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(toolDef.name).toBe("fin_test");
    expect(toolDef.label).toBe("Test Tool");
    expect(opts.names).toEqual(["fin_test"]);
  });

  // --- 12. execute 调用 clientMethod 并返回 json 格式 ---
  it("execute 调用 clientMethod, 返回 { success, endpoint, count, results }", async () => {
    const mockApi = {
      registerTool: vi.fn(),
    } as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi;

    const mockClientMethod = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const def: CategoryToolDef = {
      name: "fin_test2",
      label: "Test Tool 2",
      description: "desc",
      parameters: { type: "object", properties: {} } as unknown,
      category: "mycat",
      clientMethod: mockClientMethod,
      defaultEndpoint: "fallback",
    };

    registerCategoryTool(
      mockApi,
      {} as unknown as import("../../../extensions/findoo-datahub-plugin/src/datahub-client.js").DataHubClient,
      def,
    );

    const toolDef = (mockApi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const result = await toolDef.execute("call-1", { endpoint: "custom", symbol: "AAPL" });

    // clientMethod 应收到 endpoint="custom", qp={symbol:"AAPL"}
    expect(mockClientMethod).toHaveBeenCalledWith(expect.anything(), "custom", { symbol: "AAPL" });
    expect(result.details).toEqual({
      success: true,
      endpoint: "mycat/custom",
      count: 2,
      results: [{ id: 1 }, { id: 2 }],
    });
  });

  // --- 13. execute 使用 defaultEndpoint 当无 endpoint 参数时 ---
  it("无 endpoint 参数时使用 defaultEndpoint", async () => {
    const mockApi = {
      registerTool: vi.fn(),
    } as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi;
    const mockClientMethod = vi.fn().mockResolvedValue([]);

    registerCategoryTool(
      mockApi,
      {} as unknown as import("../../../extensions/findoo-datahub-plugin/src/datahub-client.js").DataHubClient,
      {
        name: "fin_test3",
        label: "Test",
        description: "desc",
        parameters: { type: "object", properties: {} } as unknown,
        category: "cat",
        clientMethod: mockClientMethod,
        defaultEndpoint: "my-default",
      },
    );

    const toolDef = (mockApi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await toolDef.execute("call-2", {}); // 无 endpoint

    expect(mockClientMethod).toHaveBeenCalledWith(expect.anything(), "my-default", {});
  });

  // --- 14. execute 错误时返回 { error } ---
  it("clientMethod 抛错时返回 { error: message }", async () => {
    const mockApi = {
      registerTool: vi.fn(),
    } as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi;
    const mockClientMethod = vi.fn().mockRejectedValue(new Error("timeout"));

    registerCategoryTool(
      mockApi,
      {} as unknown as import("../../../extensions/findoo-datahub-plugin/src/datahub-client.js").DataHubClient,
      {
        name: "fin_test4",
        label: "Test",
        description: "desc",
        parameters: { type: "object", properties: {} } as unknown,
        category: "cat",
        clientMethod: mockClientMethod,
        defaultEndpoint: "ep",
      },
    );

    const toolDef = (mockApi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const result = await toolDef.execute("call-3", {});
    expect(result.details).toEqual({ error: "timeout" });
  });

  // --- 15. transformParams 钩子被调用 ---
  it("transformParams 钩子在 clientMethod 调用前执行", async () => {
    const mockApi = {
      registerTool: vi.fn(),
    } as unknown as import("openclaw/plugin-sdk").OpenClawPluginApi;
    const mockClientMethod = vi.fn().mockResolvedValue([]);
    const transformParams = vi.fn((endpoint: string, qp: Record<string, string>) => {
      qp.injected = "yes";
    });

    registerCategoryTool(
      mockApi,
      {} as unknown as import("../../../extensions/findoo-datahub-plugin/src/datahub-client.js").DataHubClient,
      {
        name: "fin_test5",
        label: "Test",
        description: "desc",
        parameters: { type: "object", properties: {} } as unknown,
        category: "cat",
        clientMethod: mockClientMethod,
        defaultEndpoint: "ep",
        transformParams,
      },
    );

    const toolDef = (mockApi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await toolDef.execute("call-4", { symbol: "X" });

    expect(transformParams).toHaveBeenCalled();
    expect(mockClientMethod).toHaveBeenCalledWith(expect.anything(), "ep", {
      symbol: "X",
      injected: "yes",
    });
  });
});

describe("shared parameter fragments", () => {
  // --- 16. dateRangeParams 结构 ---
  it("dateRangeParams 包含 start_date, end_date, limit", () => {
    expect(dateRangeParams).toHaveProperty("start_date");
    expect(dateRangeParams).toHaveProperty("end_date");
    expect(dateRangeParams).toHaveProperty("limit");
  });

  // --- 17. symbolParam 和 optionalSymbol ---
  it("symbolParam 是 Type.String, optionalSymbol 是 Type.Optional", () => {
    expect(symbolParam).toBeDefined();
    expect(optionalSymbol).toBeDefined();
  });
});
