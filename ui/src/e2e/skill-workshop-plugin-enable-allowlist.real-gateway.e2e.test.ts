import { defineSkillWorkshopEnableSuite } from "./skill-workshop-plugin-enable.real-gateway.test-support.ts";

defineSkillWorkshopEnableSuite({
  name: "Skill Workshop turned on from its page past a plugin allowlist",
  // A hardened install that, after the migration, admits only named plugins.
  plugins: { allow: ["memory-core"] },
  expectedAllow: ["memory-core", "skill-workshop"],
});
