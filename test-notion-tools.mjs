#!/usr/bin/env node
// Test notion API with direct HTTP requests
const token = process.env.NOTION_TOKEN;
if (!token) {
  console.error("NOTION_TOKEN environment variable is required");
  process.exit(1);
}

const API_VERSION = "2026-03-11";
const BASE_URL = "https://api.notion.com/v1";

async function notionRequest(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": API_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `Notion API error: ${response.status} - ${data.message || JSON.stringify(data)}`,
    );
  }
  return data;
}

async function main() {
  console.log("Searching for a page to create a database in...");
  const searchResult = await notionRequest("/search", {
    method: "POST",
    body: JSON.stringify({
      query: "",
      filter: { property: "object", value: "page" },
      page_size: 5,
    }),
  });

  if (!searchResult.results || searchResult.results.length === 0) {
    console.error(
      "No pages found. Please create a page in Notion and share it with your integration.",
    );
    process.exit(1);
  }

  const pageId = searchResult.results[0].id;
  console.log(
    `Using page: ${searchResult.results[0].properties?.title?.[0]?.text?.content || pageId} (${pageId})`,
  );

  console.log("Creating database container with initial data source...");
  const databaseResult = await notionRequest("/databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: pageId },
      title: [{ text: { content: "Multiplication Table" } }],
      initial_data_source: {
        properties: {
          "Multiplier 1": { number: {} },
          "Multiplier 2": { number: {} },
          Result: { number: {} },
        },
      },
    }),
  });

  const databaseId = databaseResult.id;
  const dataSourceId = databaseResult.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(
      `Database ${databaseId} was created without a discoverable initial data source`,
    );
  }

  console.log(`Database created: ${databaseId}`);
  console.log(`Initial data source: ${dataSourceId}`);

  console.log("Creating multiplication table rows (1×1 to 5×9)...");
  let successCount = 0;
  let failCount = 0;

  for (let i = 1; i <= 5; i++) {
    for (let j = 1; j <= 9; j++) {
      try {
        const pageResult = await notionRequest("/pages", {
          method: "POST",
          body: JSON.stringify({
            parent: { data_source_id: dataSourceId },
            properties: {
              "Multiplier 1": { number: i },
              "Multiplier 2": { number: j },
              Result: { number: i * j },
            },
          }),
        });
        successCount++;
        console.log(`  Created: ${i}×${j} = ${i * j}`);
      } catch (error) {
        failCount++;
        console.error(`  Failed: ${i}×${j} = ${i * j} - ${error.message}`);
      }
    }
  }

  console.log(`\nSummary: ${successCount} rows created, ${failCount} failed`);
  console.log(`Database URL: https://notion.so/${databaseId.replace(/-/g, "")}`);
  console.log(`Data source ID: ${dataSourceId}`);
}

main().catch(console.error);
