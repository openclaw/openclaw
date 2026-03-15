import * as lark from "@larksuiteoapi/node-sdk";

const APP_ID = "cli_a9f5a2858eb81cc0";
const APP_SECRET = "Rh2CZna7KK4V796KfR4SbbrAhMlUMGwK";

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
});

const markdown = `# Markdown 表格测试

这是一个测试文档，验证 Markdown 表格能否转换为飞书文档原生表格。

## 项目进度表

| 模块 | 状态 | 负责人 | 截止日期 |
|------|------|--------|----------|
| 登录功能 | ✅ 已完成 | 张三 | 2026-03-01 |
| 注册功能 | 🔄 进行中 | 李四 | 2026-03-15 |
| 支付功能 | ❌ 未开始 | 王五 | 2026-03-30 |
| 消息推送 | ✅ 已完成 | 赵六 | 2026-02-28 |

## 总结

以上是当前项目进度。
`;

async function main() {
  try {
    // Step 1: Convert markdown to blocks
    console.log("1. Converting markdown to blocks...");
    const convertRes = await client.docx.document.convert({
      data: { content_type: "markdown", content: markdown },
    });

    if (convertRes.code !== 0) {
      console.error("Convert failed:", convertRes.msg);
      return;
    }

    const blocks = convertRes.data?.blocks ?? [];
    const firstLevelBlockIds = convertRes.data?.first_level_block_ids ?? [];

    console.log(`   Converted to ${blocks.length} blocks`);
    console.log(`   First-level IDs: ${firstLevelBlockIds.length}`);

    // Show block types
    const BLOCK_TYPE_NAMES = {
      1: "Page",
      2: "Text",
      3: "H1",
      4: "H2",
      5: "H3",
      12: "Bullet",
      13: "Ordered",
      14: "Code",
      15: "Quote",
      22: "Divider",
      27: "Image",
      31: "Table",
      32: "TableCell",
    };

    for (const block of blocks) {
      const typeName = BLOCK_TYPE_NAMES[block.block_type] || `type_${block.block_type}`;
      console.log(`   Block: ${block.block_id} -> ${typeName} (${block.block_type})`);
    }

    const hasTable = blocks.some((b) => b.block_type === 31);
    const hasCells = blocks.some((b) => b.block_type === 32);
    console.log(`\n   ✅ Has Table block: ${hasTable}`);
    console.log(`   ✅ Has TableCell blocks: ${hasCells}`);

    if (!hasTable) {
      console.log(
        "\n   ⚠️  No Table block found! Markdown table was NOT converted to native table.",
      );
      return;
    }

    // Step 2: Create a new document
    console.log("\n2. Creating new document...");
    const createRes = await client.docx.document.create({
      data: { title: "表格测试 - Markdown Table Test" },
    });

    if (createRes.code !== 0) {
      console.error("Create doc failed:", createRes.msg);
      return;
    }

    const docToken = createRes.data?.document?.document_id;
    console.log(`   Document created: ${docToken}`);
    console.log(`   URL: https://feishu.cn/docx/${docToken}`);

    // Step 3: Insert blocks using Descendant API (supports Table blocks)
    console.log("\n3. Inserting blocks via Descendant API...");

    // Clean blocks for descendant API
    const descendants = blocks.map((block) => {
      const clean = { ...block };
      delete clean.parent_id;
      delete clean.children;
      return clean;
    });

    const insertRes = await client.docx.documentBlockDescendant.create({
      path: { document_id: docToken, block_id: docToken },
      data: { children_id: firstLevelBlockIds, descendants, index: -1 },
    });

    if (insertRes.code !== 0) {
      console.error("Insert failed:", insertRes.msg, `(code: ${insertRes.code})`);
      return;
    }

    console.log(`   ✅ Inserted ${insertRes.data?.children?.length ?? 0} top-level blocks`);
    console.log(`\n🎉 Success! Check the document at: https://feishu.cn/docx/${docToken}`);
  } catch (err) {
    console.error("Error:", err.message || err);
  }
}

main();
