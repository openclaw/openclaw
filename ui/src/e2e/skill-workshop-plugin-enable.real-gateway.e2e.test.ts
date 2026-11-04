import { defineSkillWorkshopEnableSuite } from "./skill-workshop-plugin-enable.real-gateway.test-support.ts";

defineSkillWorkshopEnableSuite({
  name: "Skill Workshop turned on from its page with a built Gateway and UI",
  // A user turned the bundled plugin off after it moved into a plugin.
  plugins: { entries: { "skill-workshop": { enabled: false } } },
});
