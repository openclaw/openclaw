export async function doctorCommand(runtime, options) {
    const doctorHealth = await import("../flows/doctor-health.js");
    await doctorHealth.doctorCommand(runtime, options);
}
