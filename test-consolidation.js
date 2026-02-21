#!/usr/bin/env node

// Quick test to simulate the consolidation error

// Simulate what might be returned by the LLM
const mockResponses = [
  { text: null },
  { text: undefined },
  { text: {} },
  { text: '' },
  {},
  null,
  undefined
];

console.log('Testing different response types:\n');

mockResponses.forEach((response, i) => {
  console.log(`\n--- Test ${i + 1} ---`);
  console.log('Response:', JSON.stringify(response));

  // OLD BUGGY WAY:
  // let rawStory = response?.text || "";

  // NEW FIXED WAY:
  let rawStory = typeof response?.text === "string" ? response.text : "";
  console.log('rawStory after fix:', JSON.stringify(rawStory), 'type:', typeof rawStory);

  let newStory = "";

  if (typeof rawStory === "string") {
    newStory = rawStory;
    console.log('✓ Is string, length:', newStory.length);
  } else if (rawStory && typeof rawStory === "object") {
    console.log('✗ Is object with keys:', Object.keys(rawStory).join(', '));

    const obj = rawStory;
    newStory = obj.content || obj.message || obj.response || "";

    if (!newStory) {
      console.log('❌ [MIND] Story update error: LLM returned object instead of string');
      console.log(`Response type: ${typeof rawStory}, keys: ${Object.keys(obj).join(", ")}`);
      console.log(`Full response: ${JSON.stringify(response, null, 2)}`);
      console.log(`response.text type: ${typeof response?.text}, is null: ${response?.text === null}`);
    }
  } else {
    console.log('✗ Is neither string nor object:', typeof rawStory);
  }

  if (!newStory || newStory.trim().length === 0) {
    console.log('❌ Empty story - would return currentStory');
  } else {
    console.log('✓ Story extracted successfully');
  }
});
